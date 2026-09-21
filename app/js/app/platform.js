/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 */

var Michelly = window.Michelly = window.Michelly || {};

(function (namespace) {
    'use strict';

    // Feature list kept from the previous webOS adapter.
    var SupportedFeatures = [
        'exit',
        'externallinkdisplay',
        'htmlaudioautoplay',
        'htmlvideoautoplay',
        'imageanalysis',
        'physicalvolumecontrol',
        'displaylanguage',
        'otherapppromotions',
        'targetblank',
        'screensaver',
        'subtitleappearancesettings',
        'subtitleburnsettings',
        'chromecast',
        'multiserver'
    ];

    var appInfo = {
        deviceId: null,
        deviceName: 'LG Smart TV',
        appName: 'MiChelly',
        appVersion: '0.0.0'
    };

    var deviceInfo = null;

    // Same generator the media server's web client uses: user agent + timestamp, base64, '=' -> '1'.
    function generateDeviceId() {
        return btoa([navigator.userAgent, new Date().getTime()].join('|')).replace(/=/g, '1');
    }

    // Kept under the '_deviceId2' key to mimic the media server's web client.
    function getDeviceId() {
        var deviceId = storage.get('_deviceId2');

        if (!deviceId) {
            deviceId = generateDeviceId();
            storage.set('_deviceId2', deviceId);
        }

        return deviceId;
    }

    // Resolves the device id synchronously, then fills appVersion (webOS.fetchAppInfo)
    // and deviceInfo (webOS.deviceInfo) asynchronously. cb is always called exactly once.
    function init(cb) {
        appInfo.deviceId = getDeviceId();

        var finished = false;

        function finish() {
            if (finished) {
                return;
            }
            finished = true;
            if (cb) {
                cb(appInfo);
            }
        }

        try {
            webOS.fetchAppInfo(function (info) {
                if (info && info.version) {
                    appInfo.appVersion = info.version;
                } else if (!info) {
                    console.error('Error occurs while getting appinfo.json.');
                }
                finish();
            });
        } catch (err) {
            console.warn(err);
            finish();
        }

        // Safety net: never leave the app stuck if fetchAppInfo does not call back.
        setTimeout(finish, 1500);

        try {
            webOS.deviceInfo(function (info) {
                deviceInfo = info;
            });
        } catch (err) {
            console.warn(err);
        }
    }

    function getDeviceProfile(profileBuilder) {
        return profileBuilder({
            enableMkvProgressive: false,
            enableSsaRender: true,
            supportsDolbyAtmos: deviceInfo ? deviceInfo.dolbyAtmos : null,
            supportsDolbyVision: deviceInfo ? deviceInfo.dolbyVision : null,
            supportsHdr10: deviceInfo ? deviceInfo.hdr10 : null
        });
    }

    function getSyncProfile(profileBuilder) {
        return profileBuilder({ enableMkvProgressive: false });
    }

    function getDefaultLayout() {
        return 'tv';
    }

    function getScreen() {
        return deviceInfo ? {
            width: deviceInfo.screenWidth,
            height: deviceInfo.screenHeight
        } : null;
    }

    function supports(command) {
        return !!(command && SupportedFeatures.indexOf(command.toLowerCase()) !== -1);
    }

    function exit() {
        webOS.platformBack();
    }

    function getDeviceInfo() {
        return deviceInfo;
    }

    // Values the API layer needs to build the MediaBrowser authorization header.
    function authHeaderParts() {
        return {
            client: appInfo.appName,
            device: appInfo.deviceName,
            deviceId: appInfo.deviceId,
            version: appInfo.appVersion
        };
    }

    namespace.platform = {
        appInfo: appInfo,
        generateDeviceId: generateDeviceId,
        getDeviceId: getDeviceId,
        getDeviceInfo: getDeviceInfo,
        init: init,
        getDeviceProfile: getDeviceProfile,
        getSyncProfile: getSyncProfile,
        getDefaultLayout: getDefaultLayout,
        getScreen: getScreen,
        supports: supports,
        exit: exit,
        authHeaderParts: authHeaderParts
    };
})(Michelly);
