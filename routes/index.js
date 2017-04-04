const express = require('express');
const router = express.Router();
const mysql_dbc = require('../commons/db_conn')();
const connection = mysql_dbc.init();
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const flash = require('connect-flash');
const bcrypt = require('bcrypt');
const async = require('async');
const QUERY = require('../database/query');
const JSON = require('JSON');
const fs = require('fs');
const secret_config = require('../secret/federation');

require('../database/redis')(router, 'local'); // redis
require('../helpers/helpers');

const axios = require('axios');
const request = require('request');
const STATIC_URL = 'http://static.holdemclub.tv/';

const csrf = require('csurf');
const csrfProtection = csrf({ cookie: true });
const bodyParser = require('body-parser');
const parseForm = bodyParser.urlencoded({extended:false});

const UserService = require('../service/UserService');
const util = require('../util/util');


passport.serializeUser((user, done) => {
	console.log('Serialize');
	console.log(user);
	done(null, user);
});

passport.deserializeUser((user, done) => {
	console.log('De-serialize');
	console.log(user);
	done(null, user);
});

var isAuthenticated = (req, res, next) => {
	if (req.isAuthenticated())
		return next();
	res.redirect('/login');
};

passport.use(new LocalStrategy({
	usernameField: 'user_id',
	passwordField: 'password',
	passReqToCallback: true
}, (req, user, password, done) => {
	connection.query(QUERY.USER.Login, [user], (err, data) => {
		if (err) {
			console.error(err);
			return done(null, false);
		} else {

			if(data.length === 0){
				console.log('username is not exist.');
				return done(null, null, {'message' : 'Username is not exist.'});
			}

			if (data.length === 1) {
				if (!bcrypt.compareSync(password, data[0].password)) {
					console.log('password is not matched.');
					return done(null, false, {'message' : 'Password is not matched.'});
				} else {

					// 로그인시 날짜를 해당 컬럼에 기록할 수 있어야 한다
					UserService.RecordLoginTime(data[0].user_id, (err, result) => {
						if(err){
							console.error(err);
						}
					});

					return done(null, {
						'username' : data[0].user_id,
						'nickname' : data[0].nickname,
						'market_code' : data[0].market_code
					});
				}
			} else {
				console.log('Account is duplicated.');
				return done(null, false, {message : 'Your account is duplicated.'});
			}
		}
	});
}
));

/**
 * 로그인
 * todo https로 처리할 수 있도록 리다이렉션이 필요하다.
 */
router.get('/login', function (req, res) {
	'use strict';

	if(req.user !== null){
		res.redirect('/');
	}

	let
		msg = '',
		flash_msg = req.flash(); // 캐싱을 해두지 않으면 조건에 따라서 플래시 모듈에 저장된 메시지가 사라진다.

	try{
		if(flash_msg.error.length > 0){
			console.log('message');
			console.log(flash_msg);
			msg = flash_msg.error.pop();
		}
	}catch(e){
		console.error(e);
	}

	if (req.user == null) {
		res.render('login', {
			current_path: 'login',
			title: PROJ_TITLE + ', 로그인',
			msg
		});
	} else {
		res.redirect('/');
	}
});

router.post('/login', passport.authenticate('local', {
	failureRedirect: '/login',
	failureFlash: true
}), function (req, res) {
	res.redirect('/');
});

router.get('/logout', isAuthenticated, (req, res) => {
	req.logout();
	res.redirect('/');
});


/**
 * @ Third Party Login
 */
const NaverStrategy = require('passport-naver').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const KakaoStrategy = require('passport-kakao').Strategy;

/**
 * 서드파티로 로그인할 경우 이 함수를 통해서 회원가입을 진행시키고 로그인을 자동처리해준다.
 * @param info : 서드 파티로 부터 받은 유저 정보
 * @param done : passport로부터 받은 콜백
 * TODO 유저아이디와 닉네임을 수정할 수 있도록 고지를 해준다 대신 개인 정보를 볼 수 있고 수정할 수 있는 페이지가 필요하다.
 * todo 회원가입시 guid를 통해서 유저아이디와 닉네임을 임시로 사용할 수 있도록 한다. 8자리 숫자로 조합하는 형태
 * todo 세션에서 그리고 컬럼에서 닉네임 등을 설정하지 않을 것을 확인하고 페이지를 이동할 때마다 알려준다. user_fed에 컬럼 추가할 것 boolean
 * todo 중복 에러처리를 하나의 메서드로 만든다.
 */
function loginByThirdparty(info, done) {
	console.log('process : ' + info.auth_type);

	// 트랜잭션 시작
	connection.beginTransaction(function (err) {
		if (err) {
			console.error('[err] ' + err);
			err.code = 500;
			return done(err);
		} else {
			console.log('no err on the transaction');

			// 여기서부터 트랜잭션 블록 코드
			// auth_type과 auth_id를 통해서 신규인지 기존 회원인지 알아낸다.
			var stmt_duplicated = 'select * from `user_federation` where' +
				' `auth_type`="' + info.auth_type + '" and `auth_id`="' + info.auth_id + '";';

			console.log(stmt_duplicated);

			connection.query(stmt_duplicated, function (err, data) {
				if (err) {
					console.error('[err] ' + err);
					err.code = 500;
					return done(err);
					//return next(new Error('loginByThirdpary'));
				} else {
					console.log('중복 검사 통과');
					if (data.length === 0) {
						// 신규 ->  기존 데이터와 비교하여 중복 확인할 것 -> 중복시 임의의 user_id, nickname을 생성하고 -> 회원가입 후 로그인 시킬 것.
						console.log('New User');


						/**
						 * TODO 이곳은 서드파티 첫로그인(회원 가입)시키는 구간이다
						 * TODO 1. user table에  서드파티 로그인 회원정보 저장 (user_id = auth_id를 입력(중복 제거, 로그인 이후 별도의 페이지에서 최초1회 수정하게해야됨(게임로그인을 위한 설정)), 최초 로그인 판단 칼럼 추가, auth_id 칼럼추가 FK 지정 )
						 * TODO 2. user_federation table에 서드파티 로그인 유저 정보를 저장시킨다.
						 * TODO 3. myhome 페이지에서 서드파티 로그인 유저만 아아디/닉네음을 1회만 수정가능하게 설정한다.
						 * TODO 4. 서드파티 로그인 유저 판단 로직은? (user_id = auth.id, ???)
						 *
						 * */

						var stmt_reg_new_user = 'insert into `user` set `user_id`=?, `nickname`=?, `email`=?, `last_login_dt`=?, `signup_dt`=?, `auth_id`=? ;';
						var stmt_add_user_fed = 'insert into `user_federation` set `user_id`=?, `auth_type`=?, `auth_id`=?, `auth_name`=? ';
						var current_time = service.currentTime();

						async.series([
							function (callback) {
								connection.query(stmt_reg_new_user, [info.auth_id, info.auth_name, info.auth_email, current_time, current_time, info.auth_id], function (err, reg_new_user) {
									callback(err, reg_new_user);
								})
							},
							function (callback) {
								connection.query(stmt_add_user_fed, [info.auth_id, info.auth_type, info.auth_id, info.auth_name], function (err, add_user_fed) {
									callback(err, add_user_fed);
								})
							}
						], function (err, results) {
							if (err) {
								console.error('[err] ' + err);
								err.code = 500;
								connection.rollback();
								return done(err);
							} else {
								connection.commit();
								done(null, {
									'user_id': info.auth_id,
									'nickname': info.auth_name,
									'set_game_login': false
								});
							}
						});
					} else {
						// 기존 -> user에서 데이터를 조회하여 로그인 처리할 것
						console.log('Old User');
						var stmt_old = "select * from `user_federation` where `auth_id`='" + info.auth_id + "' and `auth_type`='" + info.auth_type + "'";
						var stmt_get_user_info = 'select * from `user` where `auth_id`=?;';

						async.series([
							function (callback) {
								connection.query(stmt_old, function (err, user_info_from_fed) {
									callback(err, user_info_from_fed);
								})
							},
							function (callback) {
								connection.query(stmt_get_user_info, info.auth_id, function (err, user_info) {
									callback(err, user_info);
								})
							}
						], function (err, results) {
							if (err) {
								console.error('[err] ' + err);
								err.code = 500;
								return done(err);
							} else {
								done(null, {
									'user_id': results[1][0].user_id,
									'nickname': results[1][0].nickname,
									'set_game_login': (results[1][0].game_login === 0) ? false : true
								});
							}
						});
					}
				}
			});
		}
	});
}


// naver login
passport.use(new NaverStrategy({
		clientID: secret_config.naver.client_id,
		clientSecret: secret_config.naver.secret_id,
		callbackURL: secret_config.naver.callback_url
	},
	function (accessToken, refreshToken, profile, done) {
		var _profile = profile._json;

		console.log('Naver login info');
		console.info(_profile);

		loginByThirdparty({
			'auth_type': 'naver',
			'auth_id': _profile.id,
			'auth_name': _profile.nickname,
			'auth_email': _profile.email
		}, done);

	}
));

// 페이스북으로 로그인 처리
passport.use(new FacebookStrategy({
		clientID: secret_config.facebook.client_id,
		clientSecret: secret_config.facebook.secret_id,
		callbackURL: secret_config.facebook.callback_url,
		profileFields: ['id', 'email', 'gender', 'link', 'locale', 'name', 'timezone',
			'updated_time', 'verified', 'displayName']
	}, function (accessToken, refreshToken, profile, done) {
		var _profile = profile._json;

		console.log('Facebook login info');
		console.info(_profile);

		loginByThirdparty({
			'auth_type': 'facebook',
			'auth_id': _profile.id,
			'auth_name': _profile.name,
			'auth_email': _profile.id
		}, done);
	}
));

// kakao로 로그인
passport.use(new KakaoStrategy({
		clientID: secret_config.kakao.client_id,
		callbackURL: secret_config.kakao.callback_url
	},
	function (accessToken, refreshToken, profile, done) {
		var _profile = profile._json;
		console.log('Kakao login info');
		console.info(_profile);
		// todo 유저 정보와 done을 공통 함수에 던지고 해당 함수에서 공통으로 회원가입 절차를 진행할 수 있도록 한다.

		loginByThirdparty({
			'auth_type': 'kakao',
			'auth_id': _profile.id,
			'auth_name': _profile.properties.nickname,
			'auth_email': _profile.id
		}, done);
	}
));

// naver 로그인
router.get('/auth/login/naver',
	passport.authenticate('naver')
);
// naver 로그인 연동 콜백
router.get('/auth/login/naver/callback',
	passport.authenticate('naver', {
		successRedirect: '/',
		failureRedirect: '/login'
	})
);

// kakao 로그인
router.get('/auth/login/kakao',
	passport.authenticate('kakao')
);
// kakao 로그인 연동 콜백
router.get('/auth/login/kakao/callback',
	passport.authenticate('kakao', {
		successRedirect: '/',
		failureRedirect: '/login'
	})
);

// facebook 로그인
router.get('/auth/login/facebook',
	passport.authenticate('facebook')
);
// facebook 로그인 연동 콜백
router.get('/auth/login/facebook/callback',
	passport.authenticate('facebook', {
		successRedirect: '/',
		failureRedirect: '/login'
	})
);



/**
 * API-DOCS
 */
router.get('/api-doc', (req, res) => {
	fs.readFile('swagger/api.json', 'utf8', (err, data) => {
		if(!err){
			console.info(data);
			res.json(JSON.parse(data));
		}else{
			console.error(err);
			res.json({});
		}
	});
});


/**
 * 메인 페이지
 */

// todo config 파일로 이동시키고 서버실행시 변경이 될 수 있도록 설정한다.
const HOST_INFO = {
	LOCAL : 'http://localhost:3002/api/',
	VERSION : 'v2'
};

const HOST = `${HOST_INFO.LOCAL}${HOST_INFO.VERSION}`;

router.get('/', (req, res) => {
	'use strict';

	async.parallel(
		[
			(cb) => { // 방송중
				request.get(`${HOST}/broadcast/live`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[live] success status is false');
							cb(null, null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			},
			(cb) => { // 좌측 채널 리스트
				request.get(`${HOST}/navigation/channel/list`, (err, res, body)=>{
					if(!err && res.statusCode == 200){
						let _body = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[navi] success status is false');
							cb('Navigation', null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			},
			(cb) => { // 최신 업데이트 비디오
				request.get(`${HOST}/video/recent/list?size=4&offset=0`, (err, res, body)  => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Video', null);
						}
					}else{
						console.error('[video] recent 3 videos');
						cb(err, null);
					}
				});
			},
			(cb) => { // 추천 채널 리스트
				request.get(`${HOST}/navigation/recommend/list`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Recom', null);
						}
					}else{
						console.error('[Recom] ');
						cb(err, null);
					}
				});
			},
			(cb) => { // 뉴스 가져오기
				request.get(`${HOST}/news/list?size=4`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('News', null);
						}
					}else{
						console.error('[News] ');
						cb(err, null);
					}
				});
			},

			// 대표 콘텐츠 가져오기
			(cb) => {
				request(`${HOST}/contents/representative/list?size=4&offset=0`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Representative', null);
						}
					}else{
						console.error('[Representative] ');
						cb(err, null);
					}
				});
			},

			// 교육 콘텐츠 가져오기
			(cb) => {
				request(`${HOST}/contents/education/list?size=4&offset=0`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Edu', null);
						}
					}else{
						console.error('[Edu] ');
						cb(err, null);
					}
				});
			},

			// 요약 콘텐츠 가져오기
			(cb) => {
				request(`${HOST}/contents/summary/list?size=4&offset=0`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Summary', null);
						}
					}else{
						console.error('[Summary] ');
						cb(err, null);
					}
				});
			}
		], (err, result) => {
		if (!err) {
			res.render('index', {
				current_path: 'INDEX',
				static : STATIC_URL,
				title: PROJ_TITLE,
				loggedIn: req.user,
				live : result[0].result,
				channels : result[1].result,
				videos : result[2].result,
				recom : result[3].result,
				news : result[4].result,
				representative : result[5].result,
				education : result[6].result,
				summary : result[7].result
			});
		} else {
			console.error(err);
			throw new Error(err);
		}
	});
});

// TODO 모든 라우터에서 항상 추춴방송, 전체 채널, 방송 여부에 대한 데이터를 항상 데이터를 가져와야 한다


router.get('/event', (req, res) => {
	'use strict';

	// 임시로 100개의 이벤트 리스트를 가져온다.
	request.get(`${HOST}/event/list?offset=0&size=100`, (err, response, body) => {
		let _body  = JSON.parse(body);
		if(!err && response.statusCode == 200){
			if(_body.success){
				res.render('event', {
					current_path: 'EVENT',
					static : STATIC_URL,
					title: PROJ_TITLE,
					loggedIn: req.user,
					list : _body.result
				});
			}else{
				console.error(err);
				throw new Error(err);
			}
		}else{
			console.error(err);
			throw new Error(err);
		}
	});
});

// 이벤트 결과 페이지
router.get('/event/:id/result', (req, res) => {
	'use strict';

	request.get(`${HOST}/event/result/${req.params.id}`, (err, response, body) => {
		let _body  = JSON.parse(body);
		if(!err && response.statusCode == 200){
			if(_body.success){
				res.render('event_result', {
					current_path: 'EVENT',
					static : STATIC_URL,
					title: PROJ_TITLE,
					loggedIn: req.user,
					result : _body.result
				});
			}else{
				console.error(err);
				throw new Error(err);
			}
		}else{
			console.error(err);
			throw new Error(err);
		}
	});
});

/**
 * 진행중인 혹은 진행이 되기 전 이벤트에 대한 정보 페이지
 */
// todo ref_id 관련 수정이 필요할지도
router.get('/event/:ref_id/information', (req, res) => {
	'use strict';

	async.parallel(
		[
			(cb) => {
				request.get(`${HOST}/event/vote/question/${req.params.ref_id}`, (err, response, body) => {
					if(!err && response.statusCode == 200){
						let _body = JSON.parse(body);
						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[vote | question] success status is false');
							cb(null, null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			},
			(cb) => {
				request.get(`${HOST}/event/vote/answer/${req.params.ref_id}`, (err, response, body) => {
					if(!err && response.statusCode == 200){
						let _body = JSON.parse(body);
						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[vote | answer] success status is false');
							cb(null, null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			}
		],
		(err, result) => {
			if (!err) {
				res.render('event_details', {
					current_path: 'EVENT',
					static : STATIC_URL,
					title: PROJ_TITLE,
					loggedIn: req.user,
					question : result[0].result,
					answer : result[1].result
				});
			} else {
				console.error(err);
				throw new Error(err);
			}
		});
});

/**
 * 비디오 리스트 뷰
 */
router.get('/channel/:channel_id', (req, res) => {
	// todo get을 통해서 데이터를 받는 부분에 대한 검증이 이루어지고
	// todo 해당 데이터를 리턴받을 수 있는 유틸을 만들어보자.
	// todo 어떤 모듈을 이용해야 하는지 조사하고 한 곳에서 반영해보자
	// todo connection 자체에서 제공하고 있는 기능에 대해서도 조사를 해보자.
	'use strict';

	async.parallel(
		[
			(cb) => {
				axios.get(`${HOST}/video/list/${req.params.channel_id}`)
					.then((response)=>{
						cb(null, response);
						console.log(response);

					}).catch((error)=>{
						console.error(error);
						cb(error, null);
					});
			},
			(cb) => { // 좌측 채널 리스트
				request.get(`${HOST}/navigation/channel/list`, (err, res, body)=>{

					if(!err && res.statusCode == 200){
						let _body = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[navi] success status is false');
							cb('Navigation', null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			},

			(cb) => { // 추천 채널 리스트
				request.get(`${HOST}/navigation/recommend/list`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Recom', null);
						}
					}else{
						console.error('[Recom] ');
						cb(err, null);
					}
				});
			},

			(cb) => { // 방송중
				request.get(`${HOST}/broadcast/live`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[live] success status is false');
							cb(null, null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			}
		],
		(err, result) => {
			if(!err){

				res.render('video_list', {
					current_path: 'VIDEOLIST',
					static : STATIC_URL,
					title: PROJ_TITLE,
					loggedIn: req.user,
					videos : JSON.stringify(result[0].data.result),
					channels : result[1].result,
					recom : result[2].result,
					live : result[3].result
				});
			}else{
				console.error(err);
				throw new Error(err);
			}
		});
});


var isMobile = require('is-mobile');
/**
 * 비디오 뷰
 */
router.get('/channel/:channel_id/video/:video_id', (req, res) => {
	'use strict';
	async.parallel(
		[
			// 달려 있는 댓글과 답글 가져오기 --> 답글 체제로만 유지할 것. 일단 스펙 아웃
			// 영상 위에 배너 광고는 항상 홀덤천국만일 것이며 이것 또한 관리자 페이지에서 수정이나 추가가 될 수 있도록 한다.
			// 채널 타이틀 가져와야
			(cb) => { // 비디오 리스트 가져오기
				axios.get(`${HOST}/video/list/${req.params.channel_id}`)
					.then((response)=>{
						cb(null, response);
						//console.log(response);
					}).catch((error)=>{
						//console.error(error);
						cb(error, null);
					});
			},
			(cb) => { // 비디오 가져오기
				axios.get(`${HOST}/video/${req.params.video_id}/information`)
					.then((response)=>{
						cb(null, response);
						//console.log(response);
					}).catch((error)=>{
						//console.error(error);
						cb(error, null);
					});
			},

			(cb) => { // 좌측 채널 리스트
				request.get(`${HOST}/navigation/channel/list`, (err, res, body)=>{

					if(!err && res.statusCode == 200){
						let _body = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[navi] success status is false');
							cb('Navigation', null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			},

			(cb) => { // 추천 채널 리스트
				request.get(`${HOST}/navigation/recommend/list`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body  = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							cb('Recom', null);
						}
					}else{
						console.error('[Recom] ');
						cb(err, null);
					}
				});
			},

			(cb) => { // 방송중
				request.get(`${HOST}/broadcast/live`, (err, res, body) => {
					if(!err && res.statusCode == 200){
						let _body = JSON.parse(body);

						if(_body.success){
							cb(null, _body);
						}else{
							console.error('[live] success status is false');
							cb(null, null);
						}
					}else{
						cb(err, null);
						console.error(err);
					}
				});
			}

		],

		(err, result) => {
			if(!err){
				var _video_info = getCurrentVideoIndex(result[0].data.result, result[1].data.result[0].video_id);
				console.log(_video_info);

				res.render('video_view', {
					current_path: 'VIDEOVIEW',
					static : STATIC_URL,
					title: PROJ_TITLE,
					loggedIn: req.user,
					videos : result[0].data.result,
					video_lists : JSON.stringify(result[0].data.result),
					video : result[1].data.result,
					prevVideo : _video_info.prev,
					nextVideo : _video_info.next,
					currentVideoId : result[1].data.result[0].video_id,
					isMobile: (isMobile(req) == 1) ? 1 : 0,
					channels : result[2].result,
					recom : result[3].result,
					live : result[4].result
				});
			}else{
				console.error(err);
				throw new Error(err);
			}
		});
});

// 일단 순차 검색을 통해서 검색 결과를 리턴한다.
function getCurrentVideoIndex(arr, target){
	var
		i=0,
		size=arr.length,
		prev = null,
		next = null;

	for(;i<size;i++){
		if(arr[i].video_id === target){
			console.log('current ' + i+1);
			if(i === 0) {
				next = i+1;
			} else if(i+1 === size) {
				prev = size-1;
			} else {
				prev = i-1;
				next = i+1;
			}
			return { prev, next };
		}
	}
	return { prev, next };
}


/**
 * 회원가입 뷰
 * todo https로 처리할 것.
 */
router.get('/signup', csrfProtection, (req, res) => {
	if(req.user != null){
		res.redirect('/');
	}

	// 하나의 객체로 묶어서 메모리에 보낼 경우 출력에 문제가 발생한다 (connect-flash)

	res.render('signup', {
		// layout : false
		current_path: 'SIGNUP',
		title : PROJ_TITLE + ', 회원가입',
		csrfToken : req.csrfToken(),
		username: req.flash('username'),
		nickname : req.flash('nickname'),
		password : req.flash('password'),
		re_password : req.flash('re_password'),
		email : req.flash('email'),
		error : req.flash('error'),
		usr_username : req.flash('usr_username'),
		usr_nickname : req.flash('usr_nickname'),
		usr_email : req.flash('usr_email')
		// todo market_code 현재 의미가 없다.
	});
});




const sanitize = require('sanitize-html');
/**
 * 회원가입 처리
 * todo https로 처리할 것
 */
router.post('/signup', parseForm, csrfProtection, (req, res) => {
	if(req.user != null){
		res.redirect('/');
	}


	// protect sql injection or xss
	const _info = {
		username : sanitize(req.body.username.trim()),
		nickname : sanitize(req.body.nickname.trim()),
		password : sanitize(req.body.password.trim()),
		re_password : sanitize(req.body.re_password.trim()),
		email : sanitize(req.body.email.trim()),
		market_code : sanitize(req.body.market_code.trim())
	};

	req.flash('usr_username', _info.username);
	req.flash('usr_nickname', _info.nickname);
	req.flash('usr_email', _info.email);

	console.log(_info);

	// 여기서부터 check validation

	// 각 필드가 비어 있으면 안된다.
	// check null or empty
	if(
		_info.username === '' || _info.username == null ||
		_info.nickname === '' || _info.nickname == null ||
		_info.password === '' || _info.password == null ||
		_info.re_password === '' || _info.re_password == null ||
		_info.email === '' || _info.email == null
	){
		req.flash('error', '잘못된 시도입니다. 정상적으로 값을 입력해주세요.');
		res.redirect('/signup');
	}

	// 아래 검사를 모두 진행을 한 후에 한꺼번에 메시지를 주자.
	async.parallel([
		(cb) => {
			axios.get(`${HOST}/users/duplication/user_id?user_id=${_info.username}`)
				.then((response)=>{
					if(response.data.success){
						cb(null, response);
					}else{
						cb('[error] check if username is duplicated or not', null);
					}
				}).catch((error)=>{
					console.error(error);
					cb(error, null);
				});
		},
		(cb) => {
			axios.get(`${HOST}/users/duplication/nickname?nickname=${_info.nickname}`)
				.then((response)=>{
					if(response.data.success){
						cb(null, response);
					}else{
						cb('[error] check if nickname is duplicated or not', null);
					}
				}).catch((error)=>{
					console.error(error);
					cb(error, null);
				});
		},
		(cb) => {
			axios.get(`${HOST}/users/duplication/email?email=${_info.email}`)
				.then((response)=>{
					if(response.data.success){
						cb(null, response);
					}else{
						cb('[error] check if email is duplicated or not', null);
					}
				}).catch((error)=>{
					console.error(error);
					cb(error, null);
				});
		}
	], (err, result) => {
		if(!err){
			var isPass = true;

			// 아이디 중복 검사
			if(!result[0].data.valid){
				req.flash('username', '중복된 아이디입니다.'); // todo 같은 키에 여러개의 값을 할당하면 컴마로 구분을 해서 입력이 되는 것을 볼 수 있다.
				isPass = false;
			}

			// 닉네임 중복검사
			if(!result[1].data.valid){
				req.flash('nickname', '중복된 닉네임입니다.');
				isPass = false;
			}

			// 이메일 중복 검사
			if(!result[2].data.valid){
				req.flash('email', '중복된 이메일입니다.');
				isPass = false;
			}

			if(_info.password !== _info.re_password){
				req.flash('password', '입력한 비밀번호가 일치하지 않습니다. ');
				req.flash('re_password', '입력한 비밀번호가 일치하지 않습니다. ');
				isPass = false;
			}

			if(_info.password.length < 8 || _info.re_password.length < 8){
				req.flash('password', '문자와 숫자를 포함하여 8자 이상 입력해야 합니다. ');
				req.flash('re_password', '문자와 숫자를 포함하여 8자 이상 입력해야 합니다. ');
				isPass = false;
			}

			if(!util.checkDigit(_info.password) || !util.checkDigit(_info.re_password)){
				req.flash('password', '숫자가 포함되어야 합니다.');
				req.flash('re_password', '숫자가 포함되어야 합니다.');
				isPass = false;
			}

			if(!util.checkIsEmail(_info.email)){
				req.flash('email', '이메일 형식이 맞지 않습니다.');
				isPass = false;
			}

			if(isPass){
				axios.post(`${HOST}/signup`, _info)
					.then((response)=>{
						if(response.data.success){
							// todo 로그인 화면으로 넘어가기 전에 메모리를 비워주거나 비워주는 설정이 필요하다? 자연스럽게 사라지는 것이 기본 세팅인 듯하다.
							res.redirect('/login');
						}
					}).catch((error)=>{
						console.error(error);
						req.flash('error', '서버에 문제가 생겼습니다. 잠시 후에 다시 시도해주세요.');
						res.redirect('signup');
					});
			}else{
				res.redirect('/signup');
			}
		}else{
			console.error(err);
			req.flash('error', '서버에 문제가 생겼습니다. 잠시 후에 다시 시도해주세요.');
			res.redirect('/signup');
		}
	});
});


router.get('/private', isAuthenticated, (req, res) => {
	res.render('private' , {
		current_path: 'PRIVATE',
		static : STATIC_URL,
		title: PROJ_TITLE,
		loggedIn: req.user
	});
});

// router.get('/test', (req, res) => {
// 	res.json({result: 'Hello World'});
// });

// router.get('/test/form', csrfProtection, (req, res) => {
// 	res.render('form', {
// 		title : PROJ_TITLE
// 		,csrfToken : req.csrfToken()
// 		// test : mysql_location // this is working!!
// 	});
// });

// router.post('/test/form/submit', parseForm, csrfProtection, (req, res) => {
// 	res.send('data is being processed');
// });

module.exports = router;