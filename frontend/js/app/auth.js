/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    // Fork-owned session store, keyed by server id. Never stores a password.
    // { "<serverId>": { userId, accessToken, userName } }
    var SESSIONS_KEY = 'michelly_sessions';

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

    namespace.auth = {
        getSession: getSession,
        saveSession: saveSession,
        clearSession: clearSession,
        hasSession: hasSession,
        logout: logout,
        login: login
    };
})(Michelly);
