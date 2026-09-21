/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    // Fork-owned stores. michelly_sessions is keyed by server id and never contains a
    // password; michelly_default_user may hold a plaintext default credential for automatic
    // sign-in (or { disabled: true } to turn that off) -- plaintext on purpose, no fake
    // obfuscation.
    // michelly_sessions: { "<serverId>": { userId, accessToken, userName } }
    var SESSIONS_KEY = 'michelly_sessions';

    // Tri-state default credential:
    //   key absent             -> built-in default (pepe/pepe), auto-login on
    //   { username, password } -> the user's own account
    //   { disabled: true }     -> auto-login off (the login screen is shown)
    var DEFAULT_USER_KEY = 'michelly_default_user';
    var BUILTIN_DEFAULT_USER = { username: 'pepe', password: 'pepe' };

    function readAll() {
        var sessions = storage.get(SESSIONS_KEY);

        if (!sessions || typeof sessions !== 'object') {
            sessions = {};
        }

        return sessions;
    }

    function getSession(serverId) {
        if (!serverId) {
            return null;
        }

        var sessions = readAll();
        return sessions[serverId] || null;
    }

    function saveSession(serverId, session) {
        if (!serverId) {
            return null;
        }

        var sessions = readAll();
        sessions[serverId] = session;
        storage.set(SESSIONS_KEY, sessions);
        return session;
    }

    function clearSession(serverId) {
        if (!serverId) {
            return;
        }

        var sessions = readAll();
        delete sessions[serverId];
        storage.set(SESSIONS_KEY, sessions);
    }

    function hasSession(serverId) {
        var session = getSession(serverId);
        return !!(session && session.accessToken);
    }

    function logout(serverId) {
        clearSession(serverId);
    }

    // cb(err, session). On success the session is persisted and never contains the password.
    function login(serverId, username, password, cb) {
        namespace.api.authenticateByName(username, password, function (data) {
            if (!data || !data.AccessToken) {
                cb({ error: 0, kind: 'network' });
                return;
            }

            var user = data.User || {};
            var session = {
                userId: user.Id || null,
                accessToken: data.AccessToken,
                userName: user.Name || username
            };

            saveSession(serverId, session);
            cb(null, session);
        }, function (err) {
            cb(err);
        });
    }

    // Normalized read: null when absent/malformed (=> built-in), { disabled: true },
    // or a fresh { username, password } copy. Never a live reference to the stored object.
    function readDefaultUser() {
        var stored;

        try {
            stored = storage.get(DEFAULT_USER_KEY);
        } catch (err) {
            // Malformed JSON counts as absence -> built-in default.
            return null;
        }

        if (!stored || typeof stored !== 'object') {
            return null;
        }

        if (stored.disabled === true) {
            return { disabled: true };
        }

        if (typeof stored.username !== 'string' || typeof stored.password !== 'string') {
            return null;
        }

        return { username: stored.username, password: stored.password };
    }

    // Fresh { username, password } for automatic sign-in, or null when it is turned off.
    function getDefaultUser() {
        var stored = readDefaultUser();

        if (!stored) {
            return { username: BUILTIN_DEFAULT_USER.username, password: BUILTIN_DEFAULT_USER.password };
        }

        if (stored.disabled) {
            return null;
        }

        return { username: stored.username, password: stored.password };
    }

    // Requires a non-empty username; an empty password is allowed.
    function setDefaultUser(username, password) {
        if (typeof username !== 'string' || username === '') {
            return null;
        }

        var user = {
            username: username,
            password: typeof password === 'string' ? password : ''
        };

        storage.set(DEFAULT_USER_KEY, user);
        return user;
    }

    function disableDefaultUser() {
        storage.set(DEFAULT_USER_KEY, { disabled: true });
    }

    function resetDefaultUser() {
        storage.remove(DEFAULT_USER_KEY);
    }

    namespace.auth = {
        getSession: getSession,
        saveSession: saveSession,
        clearSession: clearSession,
        hasSession: hasSession,
        logout: logout,
        login: login,
        getDefaultUser: getDefaultUser,
        setDefaultUser: setDefaultUser,
        disableDefaultUser: disableDefaultUser,
        resetDefaultUser: resetDefaultUser
    };
})(Michelly);
