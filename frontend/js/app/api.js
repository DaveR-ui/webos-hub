/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    // The media server's own web client uses a 5s-ish timeout for its metadata calls.
    var DEFAULT_TIMEOUT = 5000;

    var baseUrl = '';
    var token = null;
    var unauthorizedHandler = null;

    function setBaseUrl(url) {
        baseUrl = url || '';
    }

    function getBaseUrl() {
        return baseUrl;
    }

    function setToken(value) {
        token = value || null;
    }

    function clearToken() {
        token = null;
    }

    function onUnauthorized(fn) {
        unauthorizedHandler = fn;
    }

    // MediaBrowser Client="...", Device="...", DeviceId="...", Version="..." [, Token="..."]
    function buildAuthHeader() {
        var parts = namespace.platform.authHeaderParts();
        var header = 'MediaBrowser Client="' + parts.client +
            '", Device="' + parts.device +
            '", DeviceId="' + parts.deviceId +
            '", Version="' + parts.version + '"';

        if (token) {
            header += ', Token="' + token + '"';
        }

        return header;
    }

    function buildQuery(params) {
        if (!params) {
            return '';
        }

        var parts = [];

        for (var key in params) {
            if (!params.hasOwnProperty(key)) {
                continue;
            }

            var value = params[key];

            if (value === undefined || value === null || value === '') {
                continue;
            }

            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
        }

        return parts.length ? ('?' + parts.join('&')) : '';
    }

    function buildUrl(path, params) {
        var endPath = path;

        if (endPath.charAt(0) !== '/') {
            endPath = '/' + endPath;
        }

        return baseUrl + endPath + buildQuery(params);
    }

    // Reuses the ajax layer's {error: ...} shape so handleFailure style callers keep working.
    function mapError(err) {
        var code = err ? err.error : 0;

        if (code === 'timeout') {
            return { error: 'timeout', kind: 'timeout' };
        }
        if (code === 'abort') {
            return { error: 'abort', kind: 'abort' };
        }
        if (code === 401 || code === 403) {
            return { error: 401, kind: 'unauthorized' };
        }
        if (code === 0 || code === null || code === undefined) {
            return { error: 0, kind: 'network' };
        }

        return { error: code, kind: 'http' };
    }

    // Core XHR call. success(data) / error(mappedErr). Settles only once.
    function request(method, path, options, success, error) {
        options = options || {};

        var settled = false;

        function onSuccess(data) {
            if (settled) {
                return;
            }
            settled = true;
            if (success) {
                success(data);
            }
        }

        function onError(err) {
            if (settled) {
                return;
            }
            settled = true;

            var mapped = mapError(err);

            if (!options.suppressAuth && mapped.kind === 'unauthorized' && unauthorizedHandler) {
                try {
                    unauthorizedHandler(mapped);
                } catch (handlerError) {
                    console.warn(handlerError);
                }
            }

            if (error) {
                error(mapped);
            }
        }

        var settings = {
            method: method,
            headers: {
                'Accept': 'application/json',
                'Authorization': buildAuthHeader()
            },
            timeout: options.timeout || DEFAULT_TIMEOUT,
            success: onSuccess,
            error: onError
        };

        if (options.body !== undefined && options.body !== null) {
            settings.headers['Content-Type'] = 'application/json';
            settings.data = options.body;
        }

        return ajax.request(buildUrl(path, options.query), settings);
    }

    function getPublicSystemInfo(success, error) {
        return request('GET', '/System/Info/Public', null, success, error);
    }

    function authenticateByName(username, password, success, error) {
        return request('POST', '/Users/AuthenticateByName', {
            body: { Username: username, Pw: password }
        }, success, error);
    }

    function getPublicUsers(success, error) {
        return request('GET', '/Users/Public', null, success, error);
    }

    function getViews(userId, success, error) {
        return request('GET', '/Users/' + encodeURIComponent(userId) + '/Views', null, success, error);
    }

    function getItems(params, success, error) {
        params = params || {};

        return request('GET', '/Items', {
            query: {
                ParentId: params.ParentId,
                Recursive: params.Recursive,
                IncludeItemTypes: params.IncludeItemTypes,
                StartIndex: params.StartIndex,
                Limit: params.Limit,
                SortBy: params.SortBy,
                SortOrder: params.SortOrder,
                Fields: 'PrimaryImageAspectRatio'
            }
        }, success, error);
    }

    function getItem(itemId, userId, success, error) {
        return request('GET', '/Users/' + encodeURIComponent(userId) +
            '/Items/' + encodeURIComponent(itemId), null, success, error);
    }

    function getEpisodes(seriesId, userId, success, error) {
        return request('GET', '/Shows/' + encodeURIComponent(seriesId) + '/Episodes', {
            query: { UserId: userId }
        }, success, error);
    }

    function getResume(userId, success, error) {
        return request('GET', '/Users/' + encodeURIComponent(userId) + '/Items/Resume', null, success, error);
    }

    // Best-effort direct-play device profile used for PlaybackInfo. Transcoding is a non-goal.
    function buildDeviceProfile(flags) {
        flags = flags || {};

        return {
            Name: 'MiChelly',
            MaxStreamingBitrate: 120000000,
            MaxStaticBitrate: 120000000,
            MusicStreamingTranscodingBitrate: 384000,
            EnableMkvProgressive: !!flags.enableMkvProgressive,
            EnableSubtitleBurnIn: false,
            DirectPlayProfiles: [
                { Container: 'mkv', Type: 'Video', VideoCodec: 'h264,hevc,mpeg4,mpeg2video,vc1', AudioCodec: 'aac,ac3,eac3,mp3,flac,opus,vorbis,dts,truehd' },
                { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: 'h264,hevc,mpeg4', AudioCodec: 'aac,ac3,eac3,mp3,alac' },
                { Container: 'ts,mpegts,mpg,mpeg', Type: 'Video', VideoCodec: 'h264,hevc,mpeg2video', AudioCodec: 'aac,ac3,eac3,mp3' },
                { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9', AudioCodec: 'vorbis,opus' },
                { Container: 'mp3,aac,m4a,flac,ogg,wav', Type: 'Audio' }
            ],
            TranscodingProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: []
        };
    }

    function getPlaybackInfo(itemId, userId, success, error) {
        var flags = namespace.platform.getDeviceProfile(function (profile) {
            return profile;
        });

        return request('POST', '/Items/' + encodeURIComponent(itemId) + '/PlaybackInfo', {
            query: { UserId: userId },
            body: {
                UserId: userId,
                DeviceProfile: buildDeviceProfile(flags)
            }
        }, success, error);
    }

    function imageUrl(itemId, type, params) {
        params = params || {};

        var query = {
            maxWidth: params.maxWidth,
            tag: params.tag
        };

        if (token) {
            // ApiKey is the current query parameter; api_key is the legacy alias.
            query.ApiKey = token;
            query.api_key = token;
        }

        return baseUrl + '/Items/' + encodeURIComponent(itemId) +
            '/Images/' + encodeURIComponent(type || 'Primary') + buildQuery(query);
    }

    // First token of a comma-separated value (e.g. "flac,mp3" -> "flac"), or '' when absent.
    function firstToken(value) {
        if (value === undefined || value === null || value === '') {
            return '';
        }

        var parts = String(value).split(',');
        var first = parts.length ? parts[0] : '';

        return first.replace(/^\s+|\s+$/g, '');
    }

    // Audio direct-stream URL. A media element cannot send the Authorization header,
    // so the token travels in the query string (ApiKey current, api_key legacy alias).
    // Jellyfin 10.10+ requires a container or an audioCodec, so never emit a bare /stream:
    // prefer the first container token (a comma list like "flac,mp3" becomes "flac"),
    // otherwise fall back to the first audioCodec token.
    function audioStreamUrl(itemId, mediaSourceId, container, audioCodec) {
        var containerValue = firstToken(container);
        var query = {
            static: 'true',
            MediaSourceId: mediaSourceId
        };

        if (containerValue) {
            query.container = containerValue;
        } else {
            var codecValue = firstToken(audioCodec);

            if (codecValue) {
                query.audioCodec = codecValue;
            }
        }

        if (token) {
            // ApiKey is the current query parameter; api_key is the legacy alias.
            query.ApiKey = token;
            query.api_key = token;
        }

        return baseUrl + '/Audio/' + encodeURIComponent(itemId) + '/stream' + buildQuery(query);
    }

    // A <video> element cannot send the Authorization header, so the token travels in the query string.
    function streamUrl(itemId, mediaSourceId, container) {
        var query = {
            static: 'true',
            MediaSourceId: mediaSourceId
        };

        if (token) {
            // ApiKey is the current query parameter; api_key is the legacy alias.
            query.ApiKey = token;
            query.api_key = token;
        }

        if (container) {
            query.Container = container;
        }

        return baseUrl + '/Videos/' + encodeURIComponent(itemId) + '/stream' + buildQuery(query);
    }

    // Optional playback session reporting (best effort, errors are swallowed).
    function postSession(path, body) {
        // suppressAuth: a background session ping must not log the user out mid-playback.
        return request('POST', path, { body: body, suppressAuth: true }, function () {}, function () {});
    }

    namespace.api = {
        setBaseUrl: setBaseUrl,
        getBaseUrl: getBaseUrl,
        setToken: setToken,
        clearToken: clearToken,
        onUnauthorized: onUnauthorized,
        getPublicSystemInfo: getPublicSystemInfo,
        authenticateByName: authenticateByName,
        getPublicUsers: getPublicUsers,
        getViews: getViews,
        getItems: getItems,
        getItem: getItem,
        getEpisodes: getEpisodes,
        getResume: getResume,
        getPlaybackInfo: getPlaybackInfo,
        imageUrl: imageUrl,
        streamUrl: streamUrl,
        audioStreamUrl: audioStreamUrl,
        postSession: postSession
    };
})(Michelly);
