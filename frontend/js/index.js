/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
*/

//Adds .includes to Array for webOS 3.0 / Chromium < 47 (Array.prototype.includes is Chrome 47+)
if (!Array.prototype.includes) {
    Array.prototype.includes = function (search, start) {
        'use strict';
        if (start === undefined) { start = 0; }
        return this.indexOf(search, start) !== -1;
    };
}

var curr_req = false;
var server_info = false;

// Set on the first user key press or click so auto-selection of a lone discovered
// server never fights the user for the picker.
var user_interacted = false;

//Adds .includes to string to do substring matching
if (!String.prototype.includes) {
  String.prototype.includes = function(search, start) {
    'use strict';

    if (search instanceof RegExp) {
      throw TypeError('first argument must not be a RegExp');
    }
    if (start === undefined) { start = 0; }
    return this.indexOf(search, start) !== -1;
  };
}


function isVisible(element) {
    return element.offsetWidth > 0 && element.offsetHeight > 0;
}

function findIndex(array, currentNode) {
    //This just implements the following function which is not available on some LG TVs
    //Array.from(allElements).findIndex(function (el) { return currentNode.isEqualNode(el); })
    for (var i = 0, item; item = array[i]; i++) {
        if (currentNode.isEqualNode(item))
            return i;
    }
}

function navigate(amount) {
    console.log("Navigating " + amount.toString() + "...")
    var element = document.activeElement;
    if (element === null) {
        navigationInit();
    } else if (!isVisible(element) || element.tagName == 'BODY') {
        navigationInit();
    } else {
        //Isolate the node that we're after
        var currentNode = element;

        //find all tab-able elements, ignoring controls inside hidden views
        var candidates = document.querySelectorAll('input, button, a, area, object, select, textarea, [contenteditable]');
        var allElements = [];
        for (var i = 0; i < candidates.length; i++) {
            if (isVisible(candidates[i])) {
                allElements.push(candidates[i]);
            }
        }

        //Find the current tab index.
        var currentIndex = findIndex(allElements, currentNode);

        //focus the following element
        if (allElements[currentIndex + amount])
            allElements[currentIndex + amount].focus();
    }
}


function upArrowPressed() {
    navigate(-1);
}

function downArrowPressed() {
    navigate(1);
}
function leftArrowPressed() {
    // Your stuff here
}

function rightArrowPressed() {
    // Your stuff here
}

function backPressed() {
    // Pop the in-app back stack first; only exit the app when it is empty.
    if (window.Michelly && Michelly.ui && Michelly.ui.handleBack()) {
        return;
    }
    webOS.platformBack();
}

document.onkeydown = function (evt) {
    evt = evt || window.event;
    user_interacted = true;
    switch (evt.keyCode) {
        case 37:
            leftArrowPressed();
            break;
        case 39:
            rightArrowPressed();
            break;
        case 38:
            upArrowPressed();
            break;
        case 40:
            downArrowPressed();
            break;
        case 461: // Back
            backPressed();
            break;
    }
};

document.onclick = function () {
    user_interacted = true;
};

function handleCheckbox(elem, evt) {
    console.log(elem);
    if (evt === true) {
        return true; // webos should be capable of toggling the checkbox by itself
    } else {
        evt = evt || window.event; //keydown event
        if (evt.keyCode == 13 || evt.keyCode == 32) { //OK button or Space
            elem.checked = !elem.checked;
        }
    }
    return false;
}

function navigationInit() {
    if (isVisible(document.querySelector('#connect'))) {
        document.querySelector('#connect').focus()
    } else if (isVisible(document.querySelector('#abort'))) {
        document.querySelector('#abort').focus()
    } else {
        //Fallback for the browse/item/player/login views: focus the first visible tabbable element.
        var candidates = document.querySelectorAll('input, button, a, area, object, select, textarea, [contenteditable]');
        for (var i = 0; i < candidates.length; i++) {
            if (isVisible(candidates[i])) {
                candidates[i].focus();
                break;
            }
        }
    }
}

function Init() {
    Michelly.ui.showView('pickerView');
    ensureSettingsAffordance();
    ensureSettingsView();

    Michelly.platform.init(function () {
        navigationInit();

        if (storage.exists('connected_servers')) {
            connected_servers = storage.get('connected_servers')
            var first_server = connected_servers[Object.keys(connected_servers)[0]]
            var prefilled = setPickerFromServerUrl(first_server.baseurl);
            if (!prefilled) {
                console.warn('Saved server "' + first_server.baseurl + '" is not on 192.168.x.x; keeping the default server fields.');
            }
            document.querySelector('#auto_connect').checked = first_server.auto_connect;
            if (window.performance && window.performance.navigation.type == window.performance.navigation.TYPE_BACK_FORWARD) {
                console.log('Got here using the browser "Back" or "Forward" button, inhibiting auto connect.');
            } else {
                if (first_server.auto_connect) {
                    // Connect to the address exactly as stored (scheme and port included),
                    // not through the 192.168.x.x picker fields.
                    console.log("Auto connecting...");
                    autoConnectSavedServer(first_server);
                }
            }
            renderServerList(connected_servers);
        }
    });
}
// Just ensure that the string has no spaces, and begins with either http:// or https:// (case insensitively), and isn't empty after the ://
function validURL(str) {
    pattern = /^https?:\/\/\S+$/i;
    return !!pattern.test(str);
}

function normalizeUrl(url) {
    url = url.trimLeft ? url.trimLeft() : url.trimStart();
    if (url.indexOf("http://") != 0 && url.indexOf("https://") != 0) {
        // assume http
        url = "http://" + url;
    }
    // normalize multiple slashes as this trips WebOS in some cases
    var parts = url.split("://");
    for (var i = 1; i < parts.length; i++) {
        var part = parts[i];
        while (true) {
            var newpart = part.replace("//", "/");
            if (newpart.length == part.length) break;
            part = newpart;
        }
        parts[i] = part;
    }
    return parts.join("://");
}

// Personal fork: the picker only ever targets a 192.168.x.x LAN host.
var SERVER_IP_PREFIX = '192.168.';
var SERVER_DEFAULT_PORT = '8096';

function isValidOctet(value) {
    if (!/^\d{1,3}$/.test(value)) {
        return false;
    }
    var num = parseInt(value, 10);
    return num >= 0 && num <= 255;
}

function isValidPort(value) {
    if (!/^\d{1,5}$/.test(value)) {
        return false;
    }
    var num = parseInt(value, 10);
    return num >= 1 && num <= 65535;
}

// Validates the three picker fields exactly as typed (an empty field is invalid,
// not a default) and composes the http:// URL. Returns null when anything is invalid.
function readPickerUrl() {
    var octet3 = document.querySelector('#octet3').value.trim();
    var octet4 = document.querySelector('#octet4').value.trim();
    var port = document.querySelector('#port').value.trim();

    if (!isValidOctet(octet3) || !isValidOctet(octet4) || !isValidPort(port)) {
        return null;
    }

    // Compose from the parsed integers so a leading-zero octet (e.g. "010") is not
    // re-read as octal by the URL parser (WHATWG IPv4: 010 -> 8) and silently
    // connects/persists the wrong host.
    var composed = 'http://' + SERVER_IP_PREFIX + String(parseInt(octet3, 10)) + '.' + String(parseInt(octet4, 10)) + ':' + String(parseInt(port, 10));
    if (!validURL(composed)) {
        return null;
    }
    return composed;
}

// Parses a stored server URL and pre-fills the three picker fields. Accepts an
// optional scheme and an optional port; returns false and changes nothing when
// the host is not 192.168.x.x or anything fails validation.
function setPickerFromServerUrl(url) {
    if (!url) {
        return false;
    }

    var match = String(url).trim().match(/^(?:(?:https?:)?\/\/)?192\.168\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?(?:\/|$)/i);
    if (!match) {
        return false;
    }

    var octet3 = match[1];
    var octet4 = match[2];
    var port = match[3] || SERVER_DEFAULT_PORT;

    if (!isValidOctet(octet3) || !isValidOctet(octet4) || !isValidPort(port)) {
        return false;
    }

    document.querySelector('#octet3').value = String(parseInt(octet3, 10));
    document.querySelector('#octet4').value = String(parseInt(octet4, 10));
    document.querySelector('#port').value = String(parseInt(port, 10));
    return true;
}

function handleServerSelect() {
    var baseurl = readPickerUrl();
    var auto_connect = document.querySelector('#auto_connect').checked;

    if (baseurl !== null) {

        displayConnecting();
        console.log(baseurl, auto_connect);

        if (curr_req) {
            console.log("There is an active request.");
            abort();
        }
        hideError();
        getServerInfo(baseurl, auto_connect);
    } else {
        console.log(baseurl);
        displayError("Please enter a valid server address: the last two parts of the IP address (0-255 each) and a port (1-65535).");
    }
}

function displayError(error) {
    var errorElem = document.querySelector('#error')
    errorElem.style.display = '';
    errorElem.innerHTML = error;
}
function hideError() {
    var errorElem = document.querySelector('#error')
    errorElem.style.display = 'none';
    errorElem.innerHTML = '&nbsp;';
}

function displayConnecting() {
    document.querySelector('#serverInfoForm').style.display = 'none';
    document.querySelector('#busy').style.display = '';
    navigationInit();
}
function hideConnecting() {
    document.querySelector('#serverInfoForm').style.display = '';
    document.querySelector('#busy').style.display = 'none';
    navigationInit();
}
function getServerInfo(baseurl, auto_connect) {
    curr_req = ajax.request(normalizeUrl(baseurl + "/System/Info/Public"), {
        method: "GET",
        success: function (data) {
            handleSuccessServerInfo(data, baseurl, auto_connect);
        },
        error: handleFailure,
        abort: handleAbort,
        timeout: 5000
    });
}

// Auto-connect path for a saved or freshly discovered server: uses the address
// exactly as given (scheme and port included) rather than the picker's 192.168.x.x fields.
function autoConnectSavedServer(server) {
    if (!server || !server.baseurl) {
        return;
    }

    displayConnecting();
    hideError();

    if (curr_req) {
        console.log("There is an active request.");
        abort();
    }

    getServerInfo(server.baseurl, true);
}

function getConnectedServers() {
    connected_servers = storage.get('connected_servers');
    if (!connected_servers) {
        connected_servers = {};
    }
    return connected_servers;
}


function handleSuccessServerInfo(data, baseurl, auto_connect) {
    curr_req = false;

    connected_servers = getConnectedServers();
    for (var server_id in connected_servers) {
        var server = connected_servers[server_id]
        if (server.baseurl == baseurl) {
            if (server.id != data.Id && server.id !== false) {
                //server has changed warn user.
                hideConnecting();
                displayError("The server ID has changed since the last connection, please check if you are reaching your own server. To connect anyway, click connect again.");
                delete connected_servers[server_id]
                connected_servers[data.Id] = ({ 'baseurl': baseurl, 'auto_connect': false, 'id': false })
                storage.set('connected_servers', connected_servers)
                return false
            }
        }
    }


    connected_servers = lruStrategy(connected_servers,4, { 'baseurl': baseurl, 'Address': baseurl, 'auto_connect': auto_connect, 'id': data.Id, 'Name':data.ServerName })

    storage.set('connected_servers', connected_servers);

    // Connected: hand off to the native media client views.
    afterConnect(baseurl, data)
    return true;
}

function lruStrategy(old_items,max_items,new_item) {
    var result = {}
    var id = new_item.id

    delete old_items[id] // LRU: re-insert entry (in front) each time it is used
    result[id] =  new_item
    var keys = Object.keys(old_items)
    for (var i=0; i<max_items-1; i++){
        var current_key=keys[i]
        result[current_key] = old_items[current_key]
    }
    return result
}

function handleAbort() {
    console.log("Aborted.")
    hideConnecting();
    curr_req = false;
}

function handleFailure(data) {
    console.log("Failure:", data)
    console.log("Could not connect to server...")
    if (data.error == 'timeout') {
        displayError("The request timed out.")
    } else if (data.error == 'abort') {
        displayError("The request was aborted.")
    } else if (typeof data.error === 'string') {
        displayError(data.error);
    } else if (typeof data.error === 'number' && data.error > 0) {
        displayError("Got HTTP error " + data.error.toString() + " from server, are you connecting to a media server?")
    } else {
        displayError("Unknown error occured, are you connecting to a media server?")
    }

    hideConnecting();
    curr_req = false;
}

function abort() {
    if (curr_req) {
        curr_req.abort()
    } else {
        hideConnecting();
    }
    console.log("Aborting...");
}

/* Post-connect flow: authenticate or reuse the saved per-server session, then browse. */

var current_baseurl = null;
var current_server_id = null;

function afterConnect(baseurl, data) {
    current_baseurl = normalizeUrl(baseurl);
    current_server_id = data.Id;

    Michelly.api.setBaseUrl(current_baseurl);

    // Playlist slots key by server id, exactly like michelly_sessions (see auth.js).
    Michelly.playlists.setServerId(current_server_id);

    var session = Michelly.auth.getSession(current_server_id);

    if (session && session.accessToken) {
        Michelly.api.setToken(session.accessToken);
        hideConnecting();
        Michelly.catalog.openViews(session.userId);
        return;
    }

    var def = Michelly.auth.getDefaultUser();

    if (!def) {
        hideConnecting();
        showLogin();
        return;
    }

    // Exactly one automatic attempt: on any failure fall through to the login screen.
    Michelly.ui.setBusy('Signing in as ' + def.username + '...');

    Michelly.auth.login(current_server_id, def.username, def.password, function (err, newSession) {
        if (err) {
            Michelly.auth.clearSession(current_server_id);
            Michelly.api.clearToken();
            hideConnecting();
            showLogin('Could not sign in as ' + def.username + ': ' + Michelly.ui.describeError(err));
            return;
        }

        Michelly.api.setToken(newSession.accessToken);
        hideConnecting();
        Michelly.catalog.openViews(newSession.userId);
    });
}

function setLoginBusy(busy) {
    var button = document.querySelector('#loginButton');
    if (!button) {
        return;
    }
    button.disabled = !!busy;
    button.textContent = busy ? 'Signing in...' : 'Login';
}

function showLogin(notice) {
    var username = document.querySelector('#loginUsername');
    var password = document.querySelector('#loginPassword');

    if (username) { username.value = ''; }
    if (password) { password.value = ''; }

    // Drop any stale in-app back entries (e.g. after a 401) so Back cannot re-enter a tokenless view.
    if (Michelly.ui.clearBackHandlers) {
        Michelly.ui.clearBackHandlers();
    }

    Michelly.ui.setError('', '#loginError');

    // Set the reason after the clear so it survives (e.g. a failed automatic sign-in).
    if (notice) {
        Michelly.ui.setError(notice, '#loginError');
    }

    setLoginBusy(false);
    Michelly.ui.showView('loginView');

    if (username) { username.focus(); }
}

function handleLogin() {
    if (!current_server_id) {
        Michelly.ui.setError('No server selected.', '#loginError');
        return false;
    }

    var username = document.querySelector('#loginUsername').value;
    var password = document.querySelector('#loginPassword').value;

    if (!username) {
        Michelly.ui.setError('Please enter a username.', '#loginError');
        return false;
    }

    Michelly.ui.setError('', '#loginError');
    setLoginBusy(true);

    Michelly.auth.login(current_server_id, username, password, function (err, session) {
        setLoginBusy(false);

        if (err) {
            if (err.kind === 'unauthorized' || err.error === 401) {
                Michelly.auth.clearSession(current_server_id);
                Michelly.ui.setError('Incorrect username or password.', '#loginError');
            } else {
                Michelly.ui.setError(Michelly.ui.describeError(err), '#loginError');
            }
            return;
        }

        Michelly.api.setToken(session.accessToken);
        Michelly.catalog.openViews(session.userId);
    });

    return false;
}

// A 401/403 while browsing clears the saved session and returns to the login view.
Michelly.api.onUnauthorized(function () {
    if (!current_server_id || !Michelly.auth.hasSession(current_server_id)) {
        return;
    }
    Michelly.auth.clearSession(current_server_id);
    Michelly.api.clearToken();
    showLogin();
});

/* Default-user settings (view + affordance built in JS; index.html is untouched) */

function setSettingsStatus(msg) {
    var status = document.querySelector('#settingsStatus');

    if (!status) {
        return;
    }

    status.textContent = msg || '';
    status.style.display = msg ? '' : 'none';
}

// Idempotently add the focusable entry point to the picker; the D-pad finds it
// through the existing visible-tabbable DOM scan.
function ensureSettingsAffordance() {
    if (document.querySelector('#openSettings')) {
        return;
    }

    var container = document.querySelector('#pickerView .container');

    if (!container) {
        return;
    }

    var button = document.createElement('button');
    button.id = 'openSettings';
    button.type = 'button';
    button.textContent = 'Default user...';
    button.onclick = function () {
        openSettings();
        return false;
    };

    container.appendChild(button);
}

// Idempotently build #settingsView and append it to <body> so the existing
// Michelly.ui.showView('settingsView') view switcher picks it up.
function ensureSettingsView() {
    if (document.querySelector('#settingsView')) {
        return;
    }

    var view = document.createElement('div');
    view.id = 'settingsView';
    view.className = 'view';

    var card = document.createElement('div');
    card.className = 'settings-card';
    view.appendChild(card);

    card.appendChild(Michelly.ui.el('h1', 'settings-title', 'Default user'));
    card.appendChild(Michelly.ui.el('p', 'settings-intro', 'The app signs in automatically with this account. Leave the password empty if the account has none.'));

    var usernameLabel = Michelly.ui.el('label', null, 'Username');
    usernameLabel.htmlFor = 'defaultUsername';
    card.appendChild(usernameLabel);

    var username = document.createElement('input');
    username.type = 'text';
    username.id = 'defaultUsername';
    card.appendChild(username);

    var passwordLabel = Michelly.ui.el('label', null, 'Password');
    passwordLabel.htmlFor = 'defaultPassword';
    card.appendChild(passwordLabel);

    var password = document.createElement('input');
    password.type = 'password';
    password.id = 'defaultPassword';
    card.appendChild(password);

    var status = Michelly.ui.el('p', 'settings-status', '');
    status.id = 'settingsStatus';
    status.style.display = 'none';
    card.appendChild(status);

    var save = Michelly.ui.el('button', 'settings-primary', 'Save');
    save.id = 'settingsSave';
    save.type = 'button';
    save.onclick = function () {
        saveDefaultUser();
        return false;
    };
    card.appendChild(save);

    var turnOff = Michelly.ui.el('button', 'settings-secondary', 'Turn off automatic sign-in');
    turnOff.id = 'settingsDisable';
    turnOff.type = 'button';
    turnOff.onclick = function () {
        Michelly.auth.disableDefaultUser();
        setSettingsStatus('Automatic sign-in is off. The login screen will be shown.');
        return false;
    };
    card.appendChild(turnOff);

    var restore = Michelly.ui.el('button', 'settings-secondary', 'Restore built-in default (pepe)');
    restore.id = 'settingsRestore';
    restore.type = 'button';
    restore.onclick = function () {
        Michelly.auth.resetDefaultUser();
        var user = Michelly.auth.getDefaultUser();
        document.querySelector('#defaultUsername').value = user ? user.username : '';
        document.querySelector('#defaultPassword').value = user ? user.password : '';
        setSettingsStatus('Restored the built-in default (pepe).');
        return false;
    };
    card.appendChild(restore);

    var back = Michelly.ui.el('button', 'settings-secondary', 'Back');
    back.id = 'settingsBack';
    back.type = 'button';
    back.onclick = function () {
        // Pop the back entry pushed by openSettings() so hardware Back does not
        // need a second press to leave the app.
        if (!Michelly.ui.handleBack()) {
            Michelly.ui.showView('pickerView');
        }
        return false;
    };
    card.appendChild(back);

    card.appendChild(Michelly.ui.el('p', 'settings-hint', 'Automatic sign-in also needs a server: to skip both screens, tick "Automatically connect on app launch" on the previous screen.'));

    document.body.appendChild(view);
}

function saveDefaultUser() {
    var username = document.querySelector('#defaultUsername').value;
    var password = document.querySelector('#defaultPassword').value;

    if (!username) {
        setSettingsStatus('Please enter a username.');
        return false;
    }

    Michelly.auth.setDefaultUser(username, password);
    setSettingsStatus('Saved. The app will sign in as ' + username + '.');
    return false;
}

function openSettings() {
    var user = Michelly.auth.getDefaultUser();
    var username = document.querySelector('#defaultUsername');
    var password = document.querySelector('#defaultPassword');

    // built-in -> pepe/pepe, custom -> current, disabled -> empty
    if (username) { username.value = user ? user.username : ''; }
    if (password) { password.value = user ? user.password : ''; }

    setSettingsStatus('');

    // Single bounded back entry: Back returns to the picker.
    Michelly.ui.clearBackHandlers();
    Michelly.ui.pushBackHandler(function () {
        Michelly.ui.showView('pickerView');
    });

    Michelly.ui.showView('settingsView');
}

/* Server auto-discovery */

var discovered_servers = {};
var connected_servers = {};

function renderServerList(server_list) {
    for (var server_id in server_list) {
        var server = server_list[server_id];
        renderSingleServer(server_id, server);
    }
}

function renderSingleServer(server_id, server) {
    var server_list = document.getElementById("serverlist");
    var server_card = document.getElementById("server_" + server_id);

    if (!server_card) {
        server_card = document.createElement("li");
        server_card.id = "server_" + server_id;
        server_card.className = "server_card";
        server_list.appendChild(server_card);
    }
    server_card.innerHTML = "";

    // Server name
    var title = document.createElement("div");
    title.className = "server_card_title";
    title.innerText = server.Name;
    server_card.appendChild(title);

    // Server URL
    var server_url = document.createElement("div");
    server_url.className = "server_card_url";
    server_url.innerText = server.Address;
    server_card.appendChild(server_url);

    // Button
    var btn = document.createElement("button");
    btn.innerText = "Connect";
    btn.type = "button";
    btn.onclick = function () {
        if (!setPickerFromServerUrl(server.baseurl || server.Address)) {
            displayError("This server is not on a 192.168.x.x address and cannot be used with this picker.");
            return;
        }
        handleServerSelect();
    };
    server_card.appendChild(btn);
}


var servers_verifying = {};

// Single identity check: only a Jellyfin media server counts.
function isJellyfinServer(data) {
    return !!(data && data.ProductName === 'Jellyfin Server');
}

// Auto-select a lone discovered server only when there is nothing saved, the user has
// not touched the UI, and exactly one Jellyfin server has been verified. Otherwise the
// picker stays authoritative and we do nothing.
function maybeAutoSelectDiscoveredServer() {
    if (user_interacted || hasSavedServers()) {
        return;
    }

    var ids = Object.keys(discovered_servers);

    if (ids.length !== 1) {
        return;
    }

    var only = discovered_servers[ids[0]];

    if (!isJellyfinServer(only.system_info_public)) {
        return;
    }

    console.log("Auto connecting to the only discovered server...");
    // Discovered Address carries its own scheme/port, so bypass the picker fields.
    autoConnectSavedServer({ baseurl: only.Address });
}

function hasSavedServers() {
    return Object.keys(getConnectedServers()).length > 0;
}

function verifyThenAdd(server) {
    if (servers_verifying[server.Id]) {
        return;
    }
    servers_verifying[server.Id] = server;

    curr_req = ajax.request(normalizeUrl(server.Address + "/System/Info/Public"), {
        method: "GET",
        success: function (data) {
            console.log("success");
            console.log(server);
            console.log(data);

            if (isJellyfinServer(data)) {
                server.system_info_public = data;
                if (!discovered_servers[server.Id]) {
                    discovered_servers[server.Id] = server;
                    renderServerList(discovered_servers);
                    maybeAutoSelectDiscoveredServer();
                }
            }
            servers_verifying[server.Id] = true;
        },
        error: function (data) {
            console.log("error");
            console.log(server);
            console.log(data);
            servers_verifying[server.Id] = false;
        },
        abort: function () {
            console.log("abort");
            console.log(server);
            servers_verifying[server.Id] = false;
        },
        timeout: 5000
    });
}


var discover = null;

function startDiscovery() {
    if (discover) {
        return;
    }
    console.log("Starting server autodiscovery...");
    discover = webOS.service.request("luna://com.daverui.michelly.service", {
        method: "discover",
        parameters: {
            uniqueToken: 'fooo'
        },
        subscribe: true,
        resubscribe: true,
        onSuccess: function (args) {
            console.log('OK:', JSON.stringify(args));

            if (args.results) {
                for (var server_id in args.results) {
                    verifyThenAdd(args.results[server_id]);
                }
            }
        },
        onFailure: function (args) {
            console.log('ERR:', JSON.stringify(args));
        }
    });
}

function stopDiscovery() {
    if (discover) {
        try {
            discover.cancel();
        } catch (err) {
            console.warn(err);
        }
        discover = null;
    }
}

startDiscovery();
