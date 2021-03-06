/*******************************************************************************

    µBlock - a browser extension to block requests.
    Copyright (C) 2014 The µBlock authors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uMatrix
*/

/* jshint bitwise: false, boss: true, esnext: true */
/* global self, Components, punycode, µBlock */

// For background page

/******************************************************************************/

(function() {

'use strict';

/******************************************************************************/

// Useful links
//
// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface
// https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules/Services.jsm

/******************************************************************************/

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
const {Services} = Cu.import('resource://gre/modules/Services.jsm', null);

/******************************************************************************/

var vAPI = self.vAPI = self.vAPI || {};
vAPI.firefox = true;

/******************************************************************************/

vAPI.app = {
    name: 'uMatrix',
    version: location.hash.slice(1)
};

/******************************************************************************/

vAPI.app.start = function() {
};

/******************************************************************************/

vAPI.app.stop = function() {
};

/******************************************************************************/

vAPI.app.restart = function() {
    // Listening in bootstrap.js
    Cc['@mozilla.org/childprocessmessagemanager;1']
        .getService(Ci.nsIMessageSender)
        .sendAsyncMessage(location.host + '-restart');
};

/******************************************************************************/

// https://stackoverflow.com/questions/6715571/how-to-get-result-of-console-trace-as-string-in-javascript-with-chrome-or-fire/28118170#28118170
/*
function logStackTrace(msg) {
    var stack;
    try {
        throw new Error('');
    }
    catch (error) {
        stack = error.stack || '';
    }
    stack = stack.split('\n').map(function(line) { return line.trim(); });
    stack.shift();
    if ( msg ) {
        stack.unshift(msg);
    }
    console.log(stack.join('\n'));
}
*/
/******************************************************************************/

// List of things that needs to be destroyed when disabling the extension
// Only functions should be added to it

var cleanupTasks = [];

// This must be updated manually, every time a new task is added/removed

// Fixed by github.com/AlexVallat:
//   https://github.com/AlexVallat/uBlock/commit/7b781248f00cbe3d61b1cc367c440db80fa06049
//   7 instances of cleanupTasks.push, but one is unique to fennec, and one to desktop.
var expectedNumberOfCleanups = 7;

window.addEventListener('unload', function() {
    for ( var cleanup of cleanupTasks ) {
        cleanup();
    }

    if ( cleanupTasks.length < expectedNumberOfCleanups ) {
        console.error(
            'uMatrix> Cleanup tasks performed: %s (out of %s)',
            cleanupTasks.length,
            expectedNumberOfCleanups
        );
    }

    // frameModule needs to be cleared too
    var frameModule = {};
    Cu.import(vAPI.getURL('frameModule.js'), frameModule);
    frameModule.contentObserver.unregister();
    Cu.unload(vAPI.getURL('frameModule.js'));
});

/******************************************************************************/

var SQLite = {
    db: null,

    open: function() {
        var path = Services.dirsvc.get('ProfD', Ci.nsIFile);
        path.append('extension-data');

        if ( !path.exists() ) {
            path.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt('0774', 8));
        }

        if ( !path.isDirectory() ) {
            throw Error('Should be a directory...');
        }

        path.append(location.host + '.sqlite');
        this.db = Services.storage.openDatabase(path);
        this.db.executeSimpleSQL(
            'CREATE TABLE IF NOT EXISTS settings' +
            '(name TEXT PRIMARY KEY NOT NULL, value TEXT);'
        );

        cleanupTasks.push(function() {
            // VACUUM somewhere else, instead on unload?
            SQLite.run('VACUUM');
            SQLite.db.asyncClose();
        });
    },

    run: function(query, values, callback) {
        if ( !this.db ) {
            this.open();
        }

        var result = {};

        query = this.db.createAsyncStatement(query);

        if ( Array.isArray(values) && values.length ) {
            var i = values.length;

            while ( i-- ) {
                query.bindByIndex(i, values[i]);
            }
        }

        query.executeAsync({
            handleResult: function(rows) {
                if ( !rows || typeof callback !== 'function' ) {
                    return;
                }

                var row;

                while ( row = rows.getNextRow() ) {
                    // we assume that there will be two columns, since we're
                    // using it only for preferences
                    result[row.getResultByIndex(0)] = row.getResultByIndex(1);
                }
            },
            handleCompletion: function(reason) {
                if ( typeof callback === 'function' && reason === 0 ) {
                    callback(result);
                }
            },
            handleError: function(error) {
                console.error('SQLite error ', error.result, error.message);
            }
        });
    }
};

/******************************************************************************/

vAPI.storage = {
    QUOTA_BYTES: 100 * 1024 * 1024,

    sqlWhere: function(col, params) {
        if ( params > 0 ) {
            params = new Array(params + 1).join('?, ').slice(0, -2);
            return ' WHERE ' + col + ' IN (' + params + ')';
        }

        return '';
    },

    get: function(details, callback) {
        if ( typeof callback !== 'function' ) {
            return;
        }

        var values = [], defaults = false;

        if ( details !== null ) {
            if ( Array.isArray(details) ) {
                values = details;
            } else if ( typeof details === 'object' ) {
                defaults = true;
                values = Object.keys(details);
            } else {
                values = [details.toString()];
            }
        }

        SQLite.run(
            'SELECT * FROM settings' + this.sqlWhere('name', values.length),
            values,
            function(result) {
                var key;

                for ( key in result ) {
                    result[key] = JSON.parse(result[key]);
                }

                if ( defaults ) {
                    for ( key in details ) {
                        if ( result[key] === undefined ) {
                            result[key] = details[key];
                        }
                    }
                }

                callback(result);
            }
        );
    },

    set: function(details, callback) {
        var key, values = [], placeholders = [];

        for ( key in details ) {
            if ( !details.hasOwnProperty(key) ) {
                continue;
            }
            values.push(key);
            values.push(JSON.stringify(details[key]));
            placeholders.push('?, ?');
        }

        if ( !values.length ) {
            return;
        }

        SQLite.run(
            'INSERT OR REPLACE INTO settings (name, value) SELECT ' +
                placeholders.join(' UNION SELECT '),
            values,
            callback
        );
    },

    remove: function(keys, callback) {
        if ( typeof keys === 'string' ) {
            keys = [keys];
        }

        SQLite.run(
            'DELETE FROM settings' + this.sqlWhere('name', keys.length),
            keys,
            callback
        );
    },

    clear: function(callback) {
        SQLite.run('DELETE FROM settings');
        SQLite.run('VACUUM', null, callback);
    },

    getBytesInUse: function(keys, callback) {
        if ( typeof callback !== 'function' ) {
            return;
        }

        SQLite.run(
            'SELECT "size" AS size, SUM(LENGTH(value)) FROM settings' +
                this.sqlWhere('name', Array.isArray(keys) ? keys.length : 0),
            keys,
            function(result) {
                callback(result.size);
            }
        );
    }
};

/******************************************************************************/

var windowWatcher = {
    onReady: function(e) {
        if ( e ) {
            this.removeEventListener(e.type, windowWatcher.onReady);
        }

        var wintype = this.document.documentElement.getAttribute('windowtype');

        if ( wintype !== 'navigator:browser' ) {
            return;
        }

        var tabBrowser = getTabBrowser(this);
        if ( !tabBrowser || !tabBrowser.tabContainer ) {
            return;
        }

        var tabContainer = tabBrowser.tabContainer;

        tabContainer.addEventListener('TabClose', tabWatcher.onTabClose);
        tabContainer.addEventListener('TabSelect', tabWatcher.onTabSelect);
        tabBrowser.addTabsProgressListener(tabWatcher);
        vAPI.contextMenu.register(this.document);

        // when new window is opened TabSelect doesn't run on the selected tab?
    },

    observe: function(win, topic) {
        if ( topic === 'domwindowopened' ) {
            win.addEventListener('DOMContentLoaded', this.onReady);
        }
    }
};

/******************************************************************************/

var tabWatcher = {
    SAME_DOCUMENT: Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT,

    onTabClose: function({target}) {
        // target is tab in Firefox, browser in Fennec
        var tabId = vAPI.tabs.getTabId(target);
        if ( tabId === vAPI.noTabId ) {
            return;
        }
        vAPI.tabs.onClosed(tabId);
        delete vAPI.toolbarButton.tabs[tabId];
    },

    onTabSelect: function({target}) {
        var tabId = vAPI.tabs.getTabId(target);
        if ( tabId === vAPI.noTabId ) {
            return;
        }
        vAPI.setIcon(tabId, getOwnerWindow(target));
    },

    onLocationChange: function(browser, webProgress, request, location, flags) {
        if ( !webProgress.isTopLevel ) {
            return;
        }

        var tabId = vAPI.tabs.getTabId(browser);

        // LOCATION_CHANGE_SAME_DOCUMENT = "did not load a new document"
        if ( flags & this.SAME_DOCUMENT ) {
            vAPI.tabs.onUpdated(tabId, {url: location.asciiSpec}, {
                tabId: tabId,
                url: browser.currentURI.asciiSpec
            });
            return;
        }

        // https://github.com/gorhill/uBlock/issues/105
        // Allow any kind of pages
        vAPI.tabs.onNavigation({
            tabId: tabId,
            url: location.asciiSpec
        });
    }
};

/******************************************************************************/

vAPI.isBehindTheSceneTabId = function(tabId) {
    return tabId.toString() === '-1';
};

vAPI.noTabId = '-1';

/******************************************************************************/

var getTabBrowser = function(win) {
    return win.gBrowser || null;
};

/******************************************************************************/

var getBrowserForTab = function(tab) {
    if ( !tab ) {
        return null;
    }
    return tab.linkedBrowser || null;
};

/******************************************************************************/

var getOwnerWindow = function(target) {
    if ( target.ownerDocument ) {
        return target.ownerDocument.defaultView;
    }

    return null;
};

/******************************************************************************/

vAPI.tabs = {};

/******************************************************************************/

vAPI.tabs.registerListeners = function() {
    // onNavigation and onUpdated handled with tabWatcher.onLocationChange
    // onClosed - handled in tabWatcher.onTabClose

    for ( var win of this.getWindows() ) {
        windowWatcher.onReady.call(win);
    }

    Services.ww.registerNotification(windowWatcher);

    cleanupTasks.push(function() {
        Services.ww.unregisterNotification(windowWatcher);

        for ( var win of vAPI.tabs.getWindows() ) {
            vAPI.contextMenu.unregister(win.document);
            win.removeEventListener('DOMContentLoaded', windowWatcher.onReady);

            var tabContainer;
            var tabBrowser = getTabBrowser(win);
            if ( !tabBrowser ) {
                continue;
            }

            if ( tabBrowser.tabContainer ) {
                tabContainer = tabBrowser.tabContainer;
                tabBrowser.removeTabsProgressListener(tabWatcher);
            }

            tabContainer.removeEventListener('TabClose', tabWatcher.onTabClose);
            tabContainer.removeEventListener('TabSelect', tabWatcher.onTabSelect);

            // Close extension tabs
            for ( var tab of tabBrowser.tabs ) {
                var browser = getBrowserForTab(tab);
                if ( browser === null ) {
                    continue;
                }
                var URI = browser.currentURI;
                if ( URI.schemeIs('chrome') && URI.host === location.host ) {
                    vAPI.tabs._remove(tab, getTabBrowser(win));
                }
            }
        }
    });
};

/******************************************************************************/

vAPI.tabs.stack = new WeakMap();
vAPI.tabs.stackId = 1;

/******************************************************************************/

vAPI.tabs.getTabId = function(target) {
    if ( !target ) {
        return vAPI.noTabId;
    }
    if ( target.linkedPanel ) {
        target = target.linkedBrowser; // target is a tab
    }
    if ( target.localName !== 'browser' ) {
        return vAPI.noTabId;
    }
    var tabId = this.stack.get(target);
    if ( tabId ) {
        return tabId;
    }
    tabId = '' + this.stackId++;
    this.stack.set(target, tabId);

    // https://github.com/gorhill/uMatrix/issues/189
    // If a new tabid-tab pair is created, tell the client code about it.
    if ( this.onNavigation ) {
        this.onNavigation({
            tabId: tabId,
            url: target.currentURI.asciiSpec
        });
    }

    return tabId;
};

/******************************************************************************/

// If tabIds is an array, then an array of tabs will be returned,
// otherwise a single tab

vAPI.tabs.getTabsForIds = function(tabIds) {
    var tabs = [];
    var singleTab = !Array.isArray(tabIds);
    if ( singleTab ) {
        tabIds = [tabIds];
    }
    for ( var tab of this.getAllSync() ) {
        var tabId = this.stack.get(getBrowserForTab(tab));
        if ( !tabId ) {
            continue;
        }
        if ( tabIds.indexOf(tabId) !== -1 ) {
            if ( singleTab ) {
                return tab;
            }
            tabs.push(tab);
        }
        if ( tabs.length >= tabIds.length ) {
            break;
        }
    }
    return tabs.length !== 0 ? tabs : null;
};

/******************************************************************************/

vAPI.tabs.get = function(tabId, callback) {
    var tab, win;

    if ( tabId === null ) {
        win = Services.wm.getMostRecentWindow('navigator:browser');
        tab = getTabBrowser(win).selectedTab;
        tabId = this.getTabId(tab);
    } else {
        tab = this.getTabsForIds(tabId);
        if ( tab ) {
            win = getOwnerWindow(tab);
        }
    }

    // For internal use
    if ( typeof callback !== 'function' ) {
        return tab;
    }

    if ( !tab ) {
        callback();
        return;
    }

    var windows = this.getWindows();
    var browser = getBrowserForTab(tab);
    var tabBrowser = getTabBrowser(win);
    var tabIndex = tabBrowser.browsers.indexOf(browser);
    var tabTitle = tab.label;

    callback({
        id: tabId,
        index: tabIndex,
        windowId: windows.indexOf(win),
        active: tab === tabBrowser.selectedTab,
        url: browser.currentURI.asciiSpec,
        title: tabTitle
    });
};

/******************************************************************************/

vAPI.tabs.getAllSync = function(window) {
    var win, tab;
    var tabs = [];

    for ( win of this.getWindows() ) {
        if ( window && window !== win ) {
            continue;
        }

        var tabBrowser = getTabBrowser(win);
        if ( tabBrowser === null ) {
            continue;
        }

        for ( tab of tabBrowser.tabs ) {
            tabs.push(tab);
        }
    }

    return tabs;
};

/******************************************************************************/

vAPI.tabs.getAll = function(callback) {
    var tabs = [];
    var win, tab;

    for ( win of this.getWindows() ) {
        var tabBrowser = getTabBrowser(win);
        if ( tabBrowser === null ) {
            continue;
        }
        for ( tab of tabBrowser.tabs ) {
            tabs.push({
                id: this.getTabId(tab),
                url: getBrowserForTab(tab).currentURI.asciiSpec
            });
        }
    }
    callback(tabs);
};

/******************************************************************************/

vAPI.tabs.getWindows = function() {
    var winumerator = Services.wm.getEnumerator('navigator:browser');
    var windows = [];

    while ( winumerator.hasMoreElements() ) {
        var win = winumerator.getNext();

        if ( !win.closed ) {
            windows.push(win);
        }
    }

    return windows;
};

/******************************************************************************/

// properties of the details object:
//   url: 'URL', // the address that will be opened
//   tabId: 1, // the tab is used if set, instead of creating a new one
//   index: -1, // undefined: end of the list, -1: following tab, or after index
//   active: false, // opens the tab in background - true and undefined: foreground
//   select: true // if a tab is already opened with that url, then select it instead of opening a new one

vAPI.tabs.open = function(details) {
    if ( !details.url ) {
        return null;
    }
    // extension pages
    if ( /^[\w-]{2,}:/.test(details.url) === false ) {
        details.url = vAPI.getURL(details.url);
    }

    var win, tab, tabBrowser;

    if ( details.select ) {
        var URI = Services.io.newURI(details.url, null, null);

        for ( tab of this.getAllSync() ) {
            var browser = getBrowserForTab(tab);

            // Or simply .equals if we care about the fragment
            if ( URI.equalsExceptRef(browser.currentURI) === false ) {
                continue;
            }

            this.select(tab);
            return;
        }
    }

    if ( details.active === undefined ) {
        details.active = true;
    }

    if ( details.tabId ) {
        tab = this.getTabsForIds(details.tabId);
        if ( tab ) {
            getBrowserForTab(tab).loadURI(details.url);
            return;
        }
    }

    win = Services.wm.getMostRecentWindow('navigator:browser');
    tabBrowser = getTabBrowser(win);

    if ( details.index === -1 ) {
        details.index = tabBrowser.browsers.indexOf(tabBrowser.selectedBrowser) + 1;
    }

    tab = tabBrowser.loadOneTab(details.url, {inBackground: !details.active});

    if ( details.index !== undefined ) {
        tabBrowser.moveTabTo(tab, details.index);
    }
};

/******************************************************************************/

// Replace the URL of a tab. Noop if the tab does not exist.

vAPI.tabs.replace = function(tabId, url) {
    var targetURL = url;

    // extension pages
    if ( /^[\w-]{2,}:/.test(targetURL) !== true ) {
        targetURL = vAPI.getURL(targetURL);
    }

    var tab = this.getTabsForIds(tabId);
    if ( tab ) {
        getBrowserForTab(tab).loadURI(targetURL);
    }
};

/******************************************************************************/

vAPI.tabs._remove = function(tab, tabBrowser) {
    tabBrowser.removeTab(tab);
};

/******************************************************************************/

vAPI.tabs.remove = function(tabIds) {
    if ( !Array.isArray(tabIds) ) {
        tabIds = [tabIds];
    }
    var tabs = this.getTabsForIds(tabIds);
    if ( !tabs ) {
        return;
    }
    for ( var tab of tabs ) {
        this._remove(tab, getTabBrowser(getOwnerWindow(tab)));
    }
};

/******************************************************************************/

vAPI.tabs.reload = function(tabId) {
    var tab = this.get(tabId);

    if ( !tab ) {
        return;
    }

    getBrowserForTab(tab).webNavigation.reload(
        Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE
    );
};

/******************************************************************************/

vAPI.tabs.select = function(tab) {
    tab = typeof tab === 'object' ? tab : this.get(tab);

    if ( !tab ) {
        return;
    }

    getTabBrowser(getOwnerWindow(tab)).selectedTab = tab;
};

/******************************************************************************/

vAPI.tabs.injectScript = function(tabId, details, callback) {
    var tab = this.get(tabId);

    if ( !tab ) {
        return;
    }

    if ( typeof details.file !== 'string' ) {
        return;
    }

    details.file = vAPI.getURL(details.file);
    getBrowserForTab(tab).messageManager.sendAsyncMessage(
        location.host + ':broadcast',
        JSON.stringify({
            broadcast: true,
            channelName: 'vAPI',
            msg: {
                cmd: 'injectScript',
                details: details
            }
        })
    );

    if ( typeof callback === 'function' ) {
        vAPI.setTimeout(callback, 13);
    }
};

/******************************************************************************/

vAPI.setIcon = function(tabId, iconId, badge) {
    // If badge is undefined, then setIcon was called from the TabSelect event
    var win;
    if ( badge === undefined ) {
        win = iconId;
    } else {
        win = Services.wm.getMostRecentWindow('navigator:browser');
    }
    var curTabId = vAPI.tabs.getTabId(getTabBrowser(win).selectedTab);
    var tb = vAPI.toolbarButton;

    // from 'TabSelect' event
    if ( tabId === undefined ) {
        tabId = curTabId;
    } else if ( badge !== undefined ) {
        tb.tabs[tabId] = { badge: badge, img: iconId };
    }

    if ( tabId === curTabId ) {
        tb.updateState(win, tabId);
    }
};

/******************************************************************************/

vAPI.messaging = {
    get globalMessageManager() {
        return Cc['@mozilla.org/globalmessagemanager;1']
                .getService(Ci.nsIMessageListenerManager);
    },
    frameScript: vAPI.getURL('frameScript.js'),
    listeners: {},
    defaultHandler: null,
    NOOPFUNC: function(){},
    UNHANDLED: 'vAPI.messaging.notHandled'
};

/******************************************************************************/

vAPI.messaging.listen = function(listenerName, callback) {
    this.listeners[listenerName] = callback;
};

/******************************************************************************/

vAPI.messaging.onMessage = function({target, data}) {
    var messageManager = target.messageManager;

    if ( !messageManager ) {
        // Message came from a popup, and its message manager is not usable.
        // So instead we broadcast to the parent window.
        messageManager = getOwnerWindow(
            target.webNavigation.QueryInterface(Ci.nsIDocShell).chromeEventHandler
        ).messageManager;
    }

    var channelNameRaw = data.channelName;
    var pos = channelNameRaw.indexOf('|');
    var channelName = channelNameRaw.slice(pos + 1);

    var callback = vAPI.messaging.NOOPFUNC;
    if ( data.requestId !== undefined ) {
        callback = CallbackWrapper.factory(
            messageManager,
            channelName,
            channelNameRaw.slice(0, pos),
            data.requestId
        ).callback;
    }

    var sender = {
        tab: {
            id: vAPI.tabs.getTabId(target)
        }
    };

    // Specific handler
    var r = vAPI.messaging.UNHANDLED;
    var listener = vAPI.messaging.listeners[channelName];
    if ( typeof listener === 'function' ) {
        r = listener(data.msg, sender, callback);
    }
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    // Default handler
    r = vAPI.messaging.defaultHandler(data.msg, sender, callback);
    if ( r !== vAPI.messaging.UNHANDLED ) {
        return;
    }

    console.error('uMatrix> messaging > unknown request: %o', data);

    // Unhandled:
    // Need to callback anyways in case caller expected an answer, or
    // else there is a memory leak on caller's side
    callback();
};

/******************************************************************************/

vAPI.messaging.setup = function(defaultHandler) {
    // Already setup?
    if ( this.defaultHandler !== null ) {
        return;
    }

    if ( typeof defaultHandler !== 'function' ) {
        defaultHandler = function(){ return vAPI.messaging.UNHANDLED; };
    }
    this.defaultHandler = defaultHandler;

    this.globalMessageManager.addMessageListener(
        location.host + ':background',
        this.onMessage
    );

    this.globalMessageManager.loadFrameScript(this.frameScript, true);

    cleanupTasks.push(function() {
        var gmm = vAPI.messaging.globalMessageManager;

        gmm.removeDelayedFrameScript(vAPI.messaging.frameScript);
        gmm.removeMessageListener(
            location.host + ':background',
            vAPI.messaging.onMessage
        );
    });
};

/******************************************************************************/

vAPI.messaging.broadcast = function(message) {
    this.globalMessageManager.broadcastAsyncMessage(
        location.host + ':broadcast',
        JSON.stringify({broadcast: true, msg: message})
    );
};

/******************************************************************************/

// This allows to avoid creating a closure for every single message which
// expects an answer. Having a closure created each time a message is processed
// has been always bothering me. Another benefit of the implementation here
// is to reuse the callback proxy object, so less memory churning.
//
// https://developers.google.com/speed/articles/optimizing-javascript
// "Creating a closure is significantly slower then creating an inner
//  function without a closure, and much slower than reusing a static
//  function"
//
// http://hacksoflife.blogspot.ca/2015/01/the-four-horsemen-of-performance.html
// "the dreaded 'uniformly slow code' case where every function takes 1%
//  of CPU and you have to make one hundred separate performance optimizations
//  to improve performance at all"
//
// http://jsperf.com/closure-no-closure/2

var CallbackWrapper = function(messageManager, channelName, listenerId, requestId) {
    this.callback = this.proxy.bind(this); // bind once
    this.init(messageManager, channelName, listenerId, requestId);
};

CallbackWrapper.junkyard = [];

CallbackWrapper.factory = function(messageManager, channelName, listenerId, requestId) {
    var wrapper = CallbackWrapper.junkyard.pop();
    if ( wrapper ) {
        wrapper.init(messageManager, channelName, listenerId, requestId);
        return wrapper;
    }
    return new CallbackWrapper(messageManager, channelName, listenerId, requestId);
};

CallbackWrapper.prototype.init = function(messageManager, channelName, listenerId, requestId) {
    this.messageManager = messageManager;
    this.channelName = channelName;
    this.listenerId = listenerId;
    this.requestId = requestId;
};

CallbackWrapper.prototype.proxy = function(response) {
    var message = JSON.stringify({
        requestId: this.requestId,
        channelName: this.channelName,
        msg: response !== undefined ? response : null
    });

    if ( this.messageManager.sendAsyncMessage ) {
        this.messageManager.sendAsyncMessage(this.listenerId, message);
    } else {
        this.messageManager.broadcastAsyncMessage(this.listenerId, message);
    }

    // Mark for reuse
    this.messageManager =
    this.channelName =
    this.requestId =
    this.listenerId = null;
    CallbackWrapper.junkyard.push(this);
};

/******************************************************************************/

var httpRequestHeadersFactory = function(channel) {
    var entry = httpRequestHeadersFactory.junkyard.pop();
    if ( entry ) {
        return entry.init(channel);
    }
    return new HTTPRequestHeaders(channel);
};

httpRequestHeadersFactory.junkyard = [];

var HTTPRequestHeaders = function(channel) {
    this.init(channel);
};

HTTPRequestHeaders.prototype.init = function(channel) {
    this.channel = channel;
    return this;
};

HTTPRequestHeaders.prototype.dispose = function() {
    this.channel = null;
    httpRequestHeadersFactory.junkyard.push(this);
};

HTTPRequestHeaders.prototype.getHeader = function(name) {
    try {
        return this.channel.getRequestHeader(name);
    } catch (e) {
    }
    return '';
};

HTTPRequestHeaders.prototype.setHeader = function(name, newValue, create) {
    var oldValue = this.getHeader(name);
    if ( newValue === oldValue ) {
        return false;
    }
    if ( oldValue === '' && create !== true ) {
        return false;
    }
    this.channel.setRequestHeader(name, newValue, false);
    return true;
};

/******************************************************************************/

var httpObserver = {
    classDescription: 'net-channel-event-sinks for ' + location.host,
    classID: Components.ID('{5d2e2797-6d68-42e2-8aeb-81ce6ba16b95}'),
    contractID: '@' + location.host + '/net-channel-event-sinks;1',
    REQDATAKEY: location.host + 'reqdata',
    ABORT: Components.results.NS_BINDING_ABORTED,
    ACCEPT: Components.results.NS_SUCCEEDED,
    // Request types:
    // https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIContentPolicy#Constants
    frameTypeMap: {
        6: 'main_frame',
        7: 'sub_frame'
    },
    typeMap: {
        1: 'other',
        2: 'script',
        3: 'image',
        4: 'stylesheet',
        5: 'object',
        6: 'main_frame',
        7: 'sub_frame',
        10: 'ping',
        11: 'xmlhttprequest',
        12: 'object',
        14: 'font',
        15: 'media',
        16: 'websocket',
        21: 'image'
    },
    mimeTypeMap: {
        'audio': 15,
        'video': 15
    },

    get componentRegistrar() {
        return Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    },

    get categoryManager() {
        return Cc['@mozilla.org/categorymanager;1']
                .getService(Ci.nsICategoryManager);
    },

    QueryInterface: (function() {
        var {XPCOMUtils} = Cu.import('resource://gre/modules/XPCOMUtils.jsm', null);

        return XPCOMUtils.generateQI([
            Ci.nsIFactory,
            Ci.nsIObserver,
            Ci.nsIChannelEventSink,
            Ci.nsISupportsWeakReference
        ]);
    })(),

    createInstance: function(outer, iid) {
        if ( outer ) {
            throw Components.results.NS_ERROR_NO_AGGREGATION;
        }

        return this.QueryInterface(iid);
    },

    register: function() {
        // https://developer.mozilla.org/en/docs/Observer_Notifications#HTTP_requests
        Services.obs.addObserver(this, 'http-on-opening-request', true);
        Services.obs.addObserver(this, 'http-on-modify-request', true);
        Services.obs.addObserver(this, 'http-on-examine-response', true);
        Services.obs.addObserver(this, 'http-on-examine-cached-response', true);

        // Guard against stale instances not having been unregistered
        if ( this.componentRegistrar.isCIDRegistered(this.classID) ) {
            try {
                this.componentRegistrar.unregisterFactory(this.classID, Components.manager.getClassObject(this.classID, Ci.nsIFactory));
            } catch (ex) {
                console.error('uMatrix> httpObserver > unable to unregister stale instance: ', ex);
            }
        }

        this.componentRegistrar.registerFactory(
            this.classID,
            this.classDescription,
            this.contractID,
            this
        );
        this.categoryManager.addCategoryEntry(
            'net-channel-event-sinks',
            this.contractID,
            this.contractID,
            false,
            true
        );
    },

    unregister: function() {
        Services.obs.removeObserver(this, 'http-on-opening-request');
        Services.obs.removeObserver(this, 'http-on-modify-request');
        Services.obs.removeObserver(this, 'http-on-examine-response');
        Services.obs.removeObserver(this, 'http-on-examine-cached-response');

        this.componentRegistrar.unregisterFactory(this.classID, this);
        this.categoryManager.deleteCategoryEntry(
            'net-channel-event-sinks',
            this.contractID,
            false
        );
    },

    handleRequest: function(channel, URI, tabId, rawtype) {
        var type = this.typeMap[rawtype] || 'other';
        var onBeforeRequest = vAPI.net.onBeforeRequest;
        if ( onBeforeRequest.types && onBeforeRequest.types.has(type) === false ) {
            return false;
        }

        var result = onBeforeRequest.callback({
            hostname: URI.asciiHost,
            parentFrameId: type === 'main_frame' ? -1 : 0,
            tabId: tabId,
            type: type,
            url: URI.asciiSpec
        });

        if ( typeof result !== 'object' ) {
            return false;
        }

        channel.cancel(this.ABORT);
        return true;
    },

    handleRequestHeaders: function(channel, URI, tabId, rawtype) {
        var type = this.typeMap[rawtype] || 'other';
        var onBeforeSendHeaders = vAPI.net.onBeforeSendHeaders;
        if ( onBeforeSendHeaders.types && onBeforeSendHeaders.types.has(type) === false ) {
            return;
        }
        var requestHeaders = httpRequestHeadersFactory(channel);
        onBeforeSendHeaders.callback({
            hostname: URI.asciiHost,
            parentFrameId: type === 'main_frame' ? -1 : 0,
            requestHeaders: requestHeaders,
            tabId: tabId,
            type: type,
            url: URI.asciiSpec
        });
        requestHeaders.dispose();
    },

    channelDataFromChannel: function(channel) {
        if ( channel instanceof Ci.nsIWritablePropertyBag ) {
            try {
                return channel.getProperty(this.REQDATAKEY);
            } catch (ex) {
            }
        }
        return null;
    },

    // https://github.com/gorhill/uMatrix/issues/165
    // https://developer.mozilla.org/en-US/Firefox/Releases/3.5/Updating_extensions#Getting_a_load_context_from_a_request
    // Not sure `umatrix:shouldLoad` is still needed, uMatrix does not
    //   care about embedded frames topography.
    // Also:
    //   https://developer.mozilla.org/en-US/Firefox/Multiprocess_Firefox/Limitations_of_chrome_scripts
    tabIdFromChannel: function(channel) {
        var aWindow;
        if ( channel.notificationCallbacks ) {
            try {
                var loadContext = channel
                        .notificationCallbacks
                        .getInterface(Ci.nsILoadContext);
                if ( loadContext.topFrameElement ) {
                    return vAPI.tabs.getTabId(loadContext.topFrameElement);
                }
                aWindow = loadContext.associatedWindow;
            } catch (ex) {
                //console.error(ex);
            }
        }
        try {
            if ( !aWindow && channel.loadGroup && channel.loadGroup.notificationCallbacks ) {
                aWindow = channel
                    .loadGroup
                    .notificationCallbacks
                    .getInterface(Ci.nsILoadContext)
                    .associatedWindow;
            }
            if ( aWindow ) {
                return vAPI.tabs.getTabId(aWindow
                    .getInterface(Ci.nsIWebNavigation)
                    .QueryInterface(Ci.nsIDocShell)
                    .rootTreeItem
                    .QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIDOMWindow)
                    .gBrowser
                    .getBrowserForContentWindow(aWindow)
                );
            }
        } catch (ex) {
            //console.error(ex);
        }
        return vAPI.noTabId;
    },

    rawtypeFromContentType: function(channel) {
        var mime = channel.contentType;
        if ( !mime ) {
            return 0;
        }
        var pos = mime.indexOf('/');
        if ( pos === -1 ) {
            pos = mime.length;
        }
        return this.mimeTypeMap[mime.slice(0, pos)] || 0;
    },

    observe: function(channel, topic) {
        if ( channel instanceof Ci.nsIHttpChannel === false ) {
            return;
        }

        var URI = channel.URI;
        var channelData, tabId, rawtype;

        if (
            topic === 'http-on-examine-response' ||
            topic === 'http-on-examine-cached-response'
        ) {
            channelData = this.channelDataFromChannel(channel);
            if ( channelData === null ) {
                return;
            }

            var type = this.frameTypeMap[channelData[1]];
            if ( !type ) {
                return;
            }

            topic = 'Content-Security-Policy';

            var result;
            try {
                result = channel.getResponseHeader(topic);
            } catch (ex) {
                result = null;
            }

            result = vAPI.net.onHeadersReceived.callback({
                hostname: URI.asciiHost,
                parentFrameId: type === 'main_frame' ? -1 : 0,
                responseHeaders: result ? [{name: topic, value: result}] : [],
                tabId: channelData[0],
                type: type,
                url: URI.asciiSpec
            });

            if ( result ) {
                channel.setResponseHeader(
                    topic,
                    result.responseHeaders.pop().value,
                    true
                );
            }

            return;
        }

        if ( topic === 'http-on-modify-request' ) {
            channelData = this.channelDataFromChannel(channel);
            if ( channelData === null ) {
                return;
            }

            this.handleRequestHeaders(channel, URI, channelData[0], channelData[1]);

            return;
        }

        // http-on-opening-request
        tabId = this.tabIdFromChannel(channel);
        rawtype = channel.loadInfo && channel.loadInfo.contentPolicyType || 1;

        if ( this.handleRequest(channel, URI, tabId, rawtype) === true ) {
            return;
        }

        if ( channel instanceof Ci.nsIWritablePropertyBag === false ) {
            return;
        }

        // Carry data for behind-the-scene redirects
        channel.setProperty(this.REQDATAKEY, [tabId, rawtype]);
    },

    // contentPolicy.shouldLoad doesn't detect redirects, this needs to be used
    asyncOnChannelRedirect: function(oldChannel, newChannel, flags, callback) {
        var result = this.ACCEPT;

        // If error thrown, the redirect will fail
        try {
            var URI = newChannel.URI;

            if ( !URI.schemeIs('http') && !URI.schemeIs('https') ) {
                return;
            }

            if ( !(oldChannel instanceof Ci.nsIWritablePropertyBag) ) {
                return;
            }

            var channelData = oldChannel.getProperty(this.REQDATAKEY);

            if ( this.handleRequest(newChannel, URI, channelData[0], channelData[1]) ) {
                result = this.ABORT;
                return;
            }

            // Carry the data on in case of multiple redirects
            if ( newChannel instanceof Ci.nsIWritablePropertyBag ) {
                newChannel.setProperty(this.REQDATAKEY, channelData);
            }
        } catch (ex) {
            // console.error(ex);
        } finally {
            callback.onRedirectVerifyCallback(result);
        }
    }
};

/******************************************************************************/

vAPI.net = {};

/******************************************************************************/

vAPI.net.registerListeners = function() {
    this.onBeforeRequest.types = this.onBeforeRequest.types ?
        new Set(this.onBeforeRequest.types) :
        null;
    this.onBeforeSendHeaders.types = this.onBeforeSendHeaders.types ?
        new Set(this.onBeforeSendHeaders.types) :
        null;

    httpObserver.register();

    cleanupTasks.push(function() {
        httpObserver.unregister();
    });
};

/******************************************************************************/

vAPI.toolbarButton = {
    id: location.host + '-button',
    type: 'view',
    viewId: location.host + '-panel',
    label: vAPI.app.name,
    tooltiptext: vAPI.app.name,
    tabs: {/*tabId: {badge: 0, img: boolean}*/}
};

/******************************************************************************/

// Toolbar button UI for desktop Firefox
vAPI.toolbarButton.init = function() {
    var CustomizableUI;
    try {
        CustomizableUI = Cu.import('resource:///modules/CustomizableUI.jsm', null).CustomizableUI;
    } catch (ex) {
        return;
    }

    this.defaultArea = CustomizableUI.AREA_NAVBAR;
    this.styleURI = [
        '#' + this.id + ' {',
            'list-style-image: url(',
                vAPI.getURL('img/browsericons/icon19-off.png'),
            ');',
        '}',
        '#' + this.viewId + ', #' + this.viewId + ' > iframe {',
            'width: 160px;',
            'height: 290px;',
            'overflow: hidden !important;',
        '}'
    ];

    var platformVersion = Services.appinfo.platformVersion;

    if ( Services.vc.compare(platformVersion, '36.0') < 0 ) {
        this.styleURI.push(
            '#' + this.id + '[badge]:not([badge=""])::after {',
                'position: absolute;',
                'margin-left: -16px;',
                'margin-top: 3px;',
                'padding: 1px 2px;',
                'font-size: 9px;',
                'font-weight: bold;',
                'color: #fff;',
                'background: #000;',
                'content: attr(badge);',
            '}'
        );
    } else {
        this.CUIEvents = {};
        var updateBadge = function() {
            var wId = vAPI.toolbarButton.id;
            var buttonInPanel = CustomizableUI.getWidget(wId).areaType === CustomizableUI.TYPE_MENU_PANEL;

            for ( var win of vAPI.tabs.getWindows() ) {
                var button = win.document.getElementById(wId);
                if ( buttonInPanel ) {
                    button.classList.remove('badged-button');
                    continue;
                }
                if ( button === null ) {
                    continue;
                }
                button.classList.add('badged-button');
            }

            if ( buttonInPanel ) {
                return;
            }

            // Anonymous elements need some time to be reachable
            vAPI.setTimeout(this.updateBadgeStyle, 250);
        }.bind(this.CUIEvents);
        this.CUIEvents.onCustomizeEnd = updateBadge;
        this.CUIEvents.onWidgetUnderflow = updateBadge;

        this.CUIEvents.updateBadgeStyle = function() {
            var css = [
                'background: #000',
                'color: #fff'
            ].join(';');

            for ( var win of vAPI.tabs.getWindows() ) {
                var button = win.document.getElementById(vAPI.toolbarButton.id);
                if ( button === null ) {
                    continue;
                }
                var badge = button.ownerDocument.getAnonymousElementByAttribute(
                    button,
                    'class',
                    'toolbarbutton-badge'
                );
                if ( !badge ) {
                    return;
                }

                badge.style.cssText = css;
            }
        };

        this.onCreated = function(button) {
            button.setAttribute('badge', '');
            vAPI.setTimeout(updateBadge, 250);
        };

        CustomizableUI.addListener(this.CUIEvents);
    }

    this.styleURI = Services.io.newURI(
        'data:text/css,' + encodeURIComponent(this.styleURI.join('')),
        null,
        null
    );

    this.closePopup = function({target}) {
        CustomizableUI.hidePanelForNode(
            target.ownerDocument.getElementById(vAPI.toolbarButton.viewId)
        );
    };

    CustomizableUI.createWidget(this);
    vAPI.messaging.globalMessageManager.addMessageListener(
        location.host + ':closePopup',
        this.closePopup
    );

    cleanupTasks.push(function() {
        if ( this.CUIEvents ) {
            CustomizableUI.removeListener(this.CUIEvents);
        }

        CustomizableUI.destroyWidget(this.id);
        vAPI.messaging.globalMessageManager.removeMessageListener(
            location.host + ':closePopup',
            this.closePopup
        );

        for ( var win of vAPI.tabs.getWindows() ) {
            var panel = win.document.getElementById(this.viewId);
            panel.parentNode.removeChild(panel);
            win.QueryInterface(Ci.nsIInterfaceRequestor)
                .getInterface(Ci.nsIDOMWindowUtils)
                .removeSheet(this.styleURI, 1);
        }
    }.bind(this));

    this.init = null;
};

/******************************************************************************/

vAPI.toolbarButton.onBeforeCreated = function(doc) {
    var panel = doc.createElement('panelview');
    panel.setAttribute('id', this.viewId);

    var iframe = doc.createElement('iframe');
    iframe.setAttribute('type', 'content');
    iframe.setAttribute('overflow-x', 'hidden');

    doc.getElementById('PanelUI-multiView')
        .appendChild(panel)
        .appendChild(iframe);

    var scrollBarWidth = 0;
    var updateTimer = null;
    var delayedResize = function() {
        if ( updateTimer ) {
            return;
        }
        updateTimer = vAPI.setTimeout(resizePopup, 10);
    };
    var resizePopup = function() {
        updateTimer = null;
        var body = iframe.contentDocument.body;
        panel.parentNode.style.maxWidth = 'none';
        // We set a limit for height
        var height = Math.min(body.clientHeight, 600);
        // https://github.com/chrisaljoudi/uBlock/issues/730
        // Voodoo programming: this recipe works
        panel.style.setProperty('height', height + 'px');
        iframe.style.setProperty('height', height + 'px');
        // Adjust width for presence/absence of vertical scroll bar which may
        // have appeared as a result of last operation.
        var contentWindow = iframe.contentWindow;
        var width = body.clientWidth;
        if ( contentWindow.scrollMaxY !== 0 ) {
            width += scrollBarWidth;
        }
        panel.style.setProperty('width', width + 'px');
        // scrollMaxX should always be zero once we know the scrollbar width
        if ( contentWindow.scrollMaxX !== 0 ) {
            scrollBarWidth = contentWindow.scrollMaxX;
            width += scrollBarWidth;
            panel.style.setProperty('width', width + 'px');
        }
        if ( iframe.clientHeight !== height || panel.clientWidth !== width ) {
            delayedResize();
            return;
        }
    };
    var onPopupReady = function() {
        var win = this.contentWindow;

        if ( !win || win.location.host !== location.host ) {
            return;
        }

        new win.MutationObserver(delayedResize).observe(win.document.body, {
            attributes: true,
            characterData: true,
            subtree: true
        });

        delayedResize();
    };

    iframe.addEventListener('load', onPopupReady, true);

    doc.defaultView.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils)
        .loadSheet(this.styleURI, 1);
};

/******************************************************************************/

vAPI.toolbarButton.onViewShowing = function({target}) {
    target.firstChild.setAttribute('src', vAPI.getURL('popup.html'));
};

/******************************************************************************/

vAPI.toolbarButton.onViewHiding = function({target}) {
    target.parentNode.style.maxWidth = '';
    target.firstChild.setAttribute('src', 'about:blank');
};

/******************************************************************************/

vAPI.toolbarButton.updateState = function(win, tabId) {
    var button = win.document.getElementById(this.id);

    if ( !button ) {
        return;
    }

    var icon = this.tabs[tabId];
    button.setAttribute('badge', icon && icon.badge || '');

    var iconId = icon && icon.img ? icon.img : 'off';
    icon = 'url(' + vAPI.getURL('img/browsericons/icon19-' + iconId + '.png') + ')';

    button.style.listStyleImage = icon;
};

/******************************************************************************/

vAPI.toolbarButton.init();

/******************************************************************************/
/******************************************************************************/

vAPI.contextMenu = {
    contextMap: {
        frame: 'inFrame',
        link: 'onLink',
        image: 'onImage',
        audio: 'onAudio',
        video: 'onVideo',
        editable: 'onEditableArea'
    }
};

/******************************************************************************/

vAPI.contextMenu.displayMenuItem = function({target}) {
    var doc = target.ownerDocument;
    var gContextMenu = doc.defaultView.gContextMenu;

    if ( !gContextMenu.browser ) {
        return;
    }

    var menuitem = doc.getElementById(vAPI.contextMenu.menuItemId);
    var currentURI = gContextMenu.browser.currentURI;

    // https://github.com/chrisaljoudi/uBlock/issues/105
    // TODO: Should the element picker works on any kind of pages?
    if ( !currentURI.schemeIs('http') && !currentURI.schemeIs('https') ) {
        menuitem.hidden = true;
        return;
    }

    var ctx = vAPI.contextMenu.contexts;

    if ( !ctx ) {
        menuitem.hidden = false;
        return;
    }

    var ctxMap = vAPI.contextMenu.contextMap;

    for ( var context of ctx ) {
        if (
            context === 'page' &&
            !gContextMenu.onLink &&
            !gContextMenu.onImage &&
            !gContextMenu.onEditableArea &&
            !gContextMenu.inFrame &&
            !gContextMenu.onVideo &&
            !gContextMenu.onAudio
        ) {
            menuitem.hidden = false;
            return;
        }

        if ( gContextMenu[ctxMap[context]] ) {
            menuitem.hidden = false;
            return;
        }
    }

    menuitem.hidden = true;
};

/******************************************************************************/

vAPI.contextMenu.register = function(doc) {
    if ( !this.menuItemId ) {
        return;
    }

    var contextMenu = doc.getElementById('contentAreaContextMenu');
    var menuitem = doc.createElement('menuitem');
    menuitem.setAttribute('id', this.menuItemId);
    menuitem.setAttribute('label', this.menuLabel);
    menuitem.setAttribute('image', vAPI.getURL('img/browsericons/icon19-19.png'));
    menuitem.setAttribute('class', 'menuitem-iconic');
    menuitem.addEventListener('command', this.onCommand);
    contextMenu.addEventListener('popupshowing', this.displayMenuItem);
    contextMenu.insertBefore(menuitem, doc.getElementById('inspect-separator'));
};

/******************************************************************************/

vAPI.contextMenu.unregister = function(doc) {
    if ( !this.menuItemId ) {
        return;
    }

    var menuitem = doc.getElementById(this.menuItemId);
    var contextMenu = menuitem.parentNode;
    menuitem.removeEventListener('command', this.onCommand);
    contextMenu.removeEventListener('popupshowing', this.displayMenuItem);
    contextMenu.removeChild(menuitem);
};

/******************************************************************************/

vAPI.contextMenu.create = function(details, callback) {
    this.menuItemId = details.id;
    this.menuLabel = details.title;
    this.contexts = details.contexts;

    if ( Array.isArray(this.contexts) && this.contexts.length ) {
        this.contexts = this.contexts.indexOf('all') === -1 ? this.contexts : null;
    } else {
        // default in Chrome
        this.contexts = ['page'];
    }

    this.onCommand = function() {
        var gContextMenu = getOwnerWindow(this).gContextMenu;
        var details = {
            menuItemId: this.id
        };

        if ( gContextMenu.inFrame ) {
            details.tagName = 'iframe';
            // Probably won't work with e10s
            details.frameUrl = gContextMenu.focusedWindow.location.href;
        } else if ( gContextMenu.onImage ) {
            details.tagName = 'img';
            details.srcUrl = gContextMenu.mediaURL;
        } else if ( gContextMenu.onAudio ) {
            details.tagName = 'audio';
            details.srcUrl = gContextMenu.mediaURL;
        } else if ( gContextMenu.onVideo ) {
            details.tagName = 'video';
            details.srcUrl = gContextMenu.mediaURL;
        } else if ( gContextMenu.onLink ) {
            details.tagName = 'a';
            details.linkUrl = gContextMenu.linkURL;
        }

        callback(details, {
            id: vAPI.tabs.getTabId(gContextMenu.browser),
            url: gContextMenu.browser.currentURI.asciiSpec
        });
    };

    for ( var win of vAPI.tabs.getWindows() ) {
        this.register(win.document);
    }
};

/******************************************************************************/

vAPI.contextMenu.remove = function() {
    for ( var win of vAPI.tabs.getWindows() ) {
        this.unregister(win.document);
    }

    this.menuItemId = null;
    this.menuLabel = null;
    this.contexts = null;
    this.onCommand = null;
};

/******************************************************************************/
/******************************************************************************/

var optionsObserver = {
    addonId: 'uMatrix@raymondhill.net',

    register: function() {
        Services.obs.addObserver(this, 'addon-options-displayed', false);
        cleanupTasks.push(this.unregister.bind(this));

        var browser = getBrowserForTab(vAPI.tabs.get(null));
        if ( browser && browser.currentURI && browser.currentURI.spec === 'about:addons' ) {
            this.observe(browser.contentDocument, 'addon-enabled', this.addonId);
        }
    },

    unregister: function() {
        Services.obs.removeObserver(this, 'addon-options-displayed');
    },

    setupOptionsButton: function(doc, id, page) {
        var button = doc.getElementById(id);
        if ( button === null ) {
            return;
        }
        button.addEventListener('command', function() {
            vAPI.tabs.open({ url: page, index: -1 });
        });
        button.label = vAPI.i18n(id);
    },

    observe: function(doc, topic, addonId) {
        if ( addonId !== this.addonId ) {
            return;
        }

        this.setupOptionsButton(doc, 'showDashboardButton', 'dashboard.html');
        this.setupOptionsButton(doc, 'showLoggerButton', 'logger-ui.html');
    }
};

optionsObserver.register();

/******************************************************************************/
/******************************************************************************/

vAPI.lastError = function() {
    return null;
};

/******************************************************************************/
/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

vAPI.onLoadAllCompleted = function() {
    for ( var tab of this.tabs.getAllSync() ) {
        // We're insterested in only the tabs that were already loaded
        getBrowserForTab(tab).messageManager.sendAsyncMessage(
            location.host + '-load-completed'
        );
    }
};

/******************************************************************************/
/******************************************************************************/

// Likelihood is that we do not have to punycode: given punycode overhead,
// it's faster to check and skip than do it unconditionally all the time.

var punycodeHostname = punycode.toASCII;
var isNotASCII = /[^\x21-\x7F]/;

vAPI.punycodeHostname = function(hostname) {
    return isNotASCII.test(hostname) ? punycodeHostname(hostname) : hostname;
};

vAPI.punycodeURL = function(url) {
    if ( isNotASCII.test(url) ) {
        return Services.io.newURI(url, null, null).asciiSpec;
    }
    return url;
};

/******************************************************************************/
/******************************************************************************/

vAPI.browserData = {};

/******************************************************************************/

// https://developer.mozilla.org/en-US/docs/HTTP_Cache

vAPI.browserData.clearCache = function(callback) {
    // PURGE_DISK_DATA_ONLY:1
    // PURGE_DISK_ALL:2
    // PURGE_EVERYTHING:3
    // However I verified that not argument does clear the cache data.
    Services.cache2.clear();
    if ( typeof callback === 'function' ) {
        callback();
    }
};

/******************************************************************************/

vAPI.browserData.clearOrigin = function(/* domain */) {
    // TODO
};

/******************************************************************************/
/******************************************************************************/

// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsICookieManager2
// https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsICookie2
// https://developer.mozilla.org/en-US/docs/Observer_Notifications#Cookies

vAPI.cookies = {};

/******************************************************************************/

vAPI.cookies.CookieEntry = function(ffCookie) {
    this.domain = ffCookie.host;
    this.name = ffCookie.name;
    this.path = ffCookie.path;
    this.secure = ffCookie.isSecure === true;
    this.session = ffCookie.expires === 0;
    this.value = ffCookie.value;
};

/******************************************************************************/

vAPI.cookies.start = function() {
    Services.obs.addObserver(this, 'cookie-changed', false);
    cleanupTasks.push(this.stop.bind(this));
};

/******************************************************************************/

vAPI.cookies.stop = function() {
    Services.obs.removeObserver(this, 'cookie-changed');
};

/******************************************************************************/

vAPI.cookies.observe = function(subject, topic, reason) {
    if ( topic !== 'cookie-changed' ) {
        return;
    }
    if ( reason === 'deleted' || subject instanceof Ci.nsICookie2 === false ) {
        return;
    }
    if ( typeof this.onChanged === 'function' ) {
        this.onChanged(new this.CookieEntry(subject));
    }
};

/******************************************************************************/

// Meant and expected to be asynchronous.

vAPI.cookies.getAll = function(callback) {
    if ( typeof callback !== 'function' ) {
        return;
    }
    var onAsync = function() {
        var out = [];
        var enumerator = Services.cookies.enumerator;
        var ffcookie;
        while ( enumerator.hasMoreElements() ) {
            ffcookie = enumerator.getNext();
            if ( ffcookie instanceof Ci.nsICookie ) {
                out.push(new this.CookieEntry(ffcookie));
            }
        }
        callback(out);
    };
    vAPI.setTimeout(onAsync.bind(this), 0);
};

/******************************************************************************/

vAPI.cookies.remove = function(details, callback) {
    var uri = Services.io.newURI(details.url, null, null);
    var cookies = Services.cookies;
    cookies.remove(uri.asciiHost, details.name, uri.path, false);
    cookies.remove( '.' + uri.asciiHost, details.name, uri.path, false);
    if ( typeof callback === 'function' ) {
        callback({
            domain: uri.asciiHost,
            name: details.name,
            path: uri.path
        });
    }
};

/******************************************************************************/
/******************************************************************************/

})();

/******************************************************************************/
