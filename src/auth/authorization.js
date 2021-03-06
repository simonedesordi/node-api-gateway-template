// logger
import * as Logger from '../log/Logger.js';
const logger = Logger.get();
const debug = Logger.debug;

// imports
import UnauthorizedAccessError from '../errors/UnauthorizedAccessError';
import {getRedisInfo} from '../init/config';

var util = require('util'),
    redis = require("redis"),
    client = redis.createClient({'host': getRedisInfo().tcpAddress}),
    _ = require("lodash"),
    config = require("../init/config.json"),
    jsonwebtoken = require("jsonwebtoken");

const TOKEN_EXPIRATION = 60, TOKEN_EXPIRATION_SEC = TOKEN_EXPIRATION * 60;

client.on('error', function (err) {
    logger.info(err);
});

client.on('connect', function () {
    logger.info("Redis successfully connected");
});

/**
 * Find the authorization headers from the headers in the request
 *
 * @param headers
 * @returns {*}
 */
module.exports.fetch = function (headers) {

    // TODO FINIRE QUI e vedere se committa la cartella del logger...
    debug('HTTP headers : ', headers);

    if (headers && headers.authorization) {
        var authorization = headers.authorization;
        debug('authorization %s', authorization);

        var part = authorization.split(' ');
        if (part.length === 2) {
            var token = part[1];
            return part[1];
        } else {
            return null;
        }
    } else {
        return null;
    }
};

/**
 * Creates a new token for the user that has been logged in
 *
 * @param user
 * @param req
 * @param res
 * @param next
 *
 * @returns {*}
 */
module.exports.create = function (user, req, res, next) {

    logger.debug("Create token");

    if (_.isEmpty(user)) {
        return next(new Error('User data cannot be empty.'));
    }

    var data = {
        _id: user._id,
        username: user.username,
        access: user.access,
        name: user.name,
        email: user.email,
        token: jsonwebtoken.sign({_id: user._id}, config.secret, {
            expiresIn: TOKEN_EXPIRATION_SEC
        })
    };

    var decoded = jsonwebtoken.decode(data.token);

    data.token_exp = decoded.exp;
    data.token_iat = decoded.iat;

    logger.debug("Token generated for user: %s, token: %s", data.username, data.token);

    client.set(data.token, JSON.stringify(data), function (err, reply) {
        if (err) {
            return next(new Error(err));
        }

        if (reply) {
            client.expire(data.token, TOKEN_EXPIRATION_SEC, function (err, reply) {
                if (err) {
                    return next(new Error("Can not set the expire value for the token key"));
                }
                if (reply) {
                    req.user = data;
                    next(); // we have succeeded
                } else {
                    return next(new Error('Expiration not set on redis'));
                }
            });
        }
        else {
            return next(new Error('Token not set in redis'));
        }
    });

    return data;

};

/**
 * Fetch the token from redis for the given key
 *
 * @param id
 * @param done
 * @returns {*}
 */
module.exports.retrieve = function (id, done) {

    logger.debug("Calling retrieve for token: %s", id);

    if (_.isNull(id)) {
        return done(new Error("token_invalid"), {
            "message": "Invalid token"
        });
    }

    client.get(id, function (err, reply) {
        if (err) {
            return done(err, {
                "message": err
            });
        }

        if (_.isNull(reply)) {
            return done(new Error("token_invalid"), {
                "message": "Token doesn't exists, are you sure it hasn't expired or been revoked?"
            });
        } else {
            var data = JSON.parse(reply);
            logger.debug("User data fetched from redis store for user: %s", data.username);

            if (_.isEqual(data.token, id)) {
                return done(null, data);
            } else {
                return done(new Error("token_doesnt_exist"), {
                    "message": "Token doesn't exists, login into the system so it can generate new token."
                });
            }

        }

    });

};

/**
 * Verifies that the token supplied in the request is valid, by checking the redis store to see if it's stored there.
 *
 * @param req
 * @param res
 * @param next
 */
module.exports.verify = function (req, res, next) {

    logger.debug("Verifying token");

    var token = exports.fetch(req.headers);

    jsonwebtoken.verify(token, config.secret, function (err, decode) {

        if (err) {
            req.user = undefined;
            return next(new UnauthorizedAccessError("invalid_token"));
        }

        exports.retrieve(token, function (err, data) {

            if (err) {
                req.user = undefined;
                return next(new UnauthorizedAccessError("invalid_token", data));
            }

            req.user = data;
            next();

        });

    });
};

/**
 * Expires the token, so the user can no longer gain access to the system, without logging in again or requesting new token
 *
 * @param headers
 * @returns {boolean}
 */
module.exports.expire = function (headers) {

    var token = exports.fetch(headers);
    logger.info('Expiring token: ' + token);

    if (token !== null) {
        logger.info('Expires token on Redis');
        client.expire(token, 0);
    }

    return token !== null;

};

/**
 * Middleware for getting the token into the user
 *
 * @param req
 * @param res
 * @param next
 */
module.exports.middleware = function () {

    var func = function (req, res, next) {

        logger.debug('middleware for token');
        var token = exports.fetch(req.headers);

        exports.retrieve(token, function (err, data) {

            if (err) {
                req.user = undefined;
                return next(new UnauthorizedAccessError("invalid_token", data));
            } else {
                req.user = _.merge(req.user, data);
                next();
            }

        });
    };

    func.unless = require("express-unless");

    return func;

};

module.exports.TOKEN_EXPIRATION = TOKEN_EXPIRATION;
module.exports.TOKEN_EXPIRATION_SEC = TOKEN_EXPIRATION_SEC;