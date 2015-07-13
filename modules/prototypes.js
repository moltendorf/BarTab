const EXPORTED_SYMBOLS = ["BarTabHandler",
	"BarTabUtils"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");


/*
 * This handler attaches to the tabbrowser.  It listens to various tab
 * related events to prevent tabs from loading or to load them upon
 * the user's request (e.g. automatic timer or context menu item).
 *
 * This object provides a small public API (see below) to perform
 * these tasks programatically, too.  You may obtain a reference to it
 * via tabbrowser.BarTabHandler.
 */
function BarTabHandler() {
}
BarTabHandler.prototype = {

	init: function (aTabBrowser) {
		aTabBrowser.BarTabHandler = this;
		this.tabbrowser = aTabBrowser;

		let document = aTabBrowser.ownerDocument;
		this.l10n = document.getElementById('bartab-strings');

		aTabBrowser.tabContainer.addEventListener('SSTabRestoring', this, false);
		aTabBrowser.tabContainer.addEventListener('TabOpen', this, false);
		aTabBrowser.tabContainer.addEventListener('TabSelect', this, false);
		aTabBrowser.tabContainer.addEventListener('TabClose', this, false);

		(new BarTabTimer()).init(aTabBrowser);

		// We need an event listener for the context menu so that we can
		// adjust the label of the whitelist menu item
		let popup = aTabBrowser.tabContainer.contextMenu;
		popup.addEventListener('popupshowing', this, false);
	},


	/*** Event handlers ***/

	handleEvent: function (aEvent) {
		switch (aEvent.type) {
			case 'SSTabRestoring':
				this.onTabRestoring(aEvent);
				return;
			case 'TabOpen':
				this.onTabOpen(aEvent);
				return;
			case 'TabSelect':
				this.onTabSelect(aEvent);
				return;
			case 'TabClose':
				this.onTabClose(aEvent);
				return;
			case 'popupshowing':
				this.onPopupShowing(aEvent);
				return;
		}
	},

	/*
	 * Hook into newly opened tabs if the user wants to prevent tabs
	 * opened in the background from loading.  (If this tab ends up not
	 * being in the background after all, 'onTabSelect' will take care
	 * of loading the tab.)
	 */
	onTabOpen: function (aEvent) {
		var tab = aEvent.originalTarget;
		if (tab.selected || BarTabUtils.getPref("loadBackgroundTabs")) {
			return;
		}
		tab.setAttribute("ontab", "true");
		(new BarTabWebProgressListener()).hook(tab);
		(new BarTabWebNavigation()).hook(tab);
	},

	/*
	 * Listen to the 'SSTabRestoring' event from the nsISessionStore
	 * service and hook into restored tabs if the user wants to prevent
	 * restored tabs from loading.
	 */
	onTabRestoring: function (aEvent) {
		let tab = aEvent.originalTarget;
		if (tab.selected || tab.getAttribute("ontab") == "true") {
			return;
		}
		tab.setAttribute("ontab", "true");
		(new BarTabWebProgressListener()).hook(tab);
		(new BarTabWebNavigation()).hook(tab);
	},

	onTabSelect: function (aEvent) {
		var tab = aEvent.originalTarget;
		if (tab.getAttribute("ontab") != "true") {
			return;
		}

		// Always load a blank page immediately
		let uri = tab.linkedBrowser.webNavigation.currentURI;
		if (!uri || (uri.spec == "about:blank")) {
			this.loadTab(tab);
			return;
		}

		let delay = BarTabUtils.getPref("loadOnSelectDelay");
		if (!delay) {
			// Load immediately
			this.loadTab(tab);
			return;
		}

		// Load after delay
		let window = tab.ownerDocument.defaultView;
		let self = this;
		window.setTimeout(function () {
			if (tab.selected) {
				self.loadTab(tab);
			}
		}, delay);
	},

	onTabClose: function (aEvent) {
		if (!BarTabUtils.getPref("findClosestLoadedTab")) {
			return;
		}
		let tab = aEvent.originalTarget;
		if (!tab.selected) {
			return;
		}
		let activeTab = this.findClosestLoadedTab(tab);
		if (activeTab) {
			this.tabbrowser.selectedTab = activeTab;
		}
	},

	onPopupShowing: function (aEvent) {
		var document = aEvent.target.ownerDocument;
		var tab = document.popupNode.localName == "tab" ?
			document.popupNode : this.tabbrowser.selectedTab;

		var neverunload = document.getElementById("context_BarTabNeverUnload");
		var unloadtab = document.getElementById("context_BarTabUnloadTab");

		let host;
		try {
			host = tab.linkedBrowser.currentURI.host;
		} catch (ex) {
			// Most likely uri.host doesn't exist which probably means
			// whitelisting doesn't make sense on this tab.  Set empty
			// host so we don't show the menu item
			host = '';
		}
		if (!host) {
			neverunload.setAttribute("hidden", "true");
			unloadtab.removeAttribute("disabled");
			return;
		}

		let label = this.l10n.getFormattedString('neverUnload', [host]);
		neverunload.setAttribute("label", label);
		neverunload.removeAttribute("hidden");
		if (BarTabUtils.whiteListed(tab.linkedBrowser.currentURI)) {
			neverunload.setAttribute("checked", "true");
			unloadtab.setAttribute("disabled", "true");
			return;
		}

		neverunload.removeAttribute("checked");
		if (tab.getAttribute("ontab") == "true") {
			unloadtab.setAttribute("disabled", "true");
		} else {
			unloadtab.removeAttribute("disabled");
		}
	},


	/*** Public API ***/

	loadTab: function (aTab) {
		if (aTab.getAttribute("ontab") != "true") {
			return;
		}
		aTab.removeAttribute("ontab");
		aTab.linkedBrowser.webNavigation._resume();
	},

	unloadTab: function (aTab) {
		// Ignore tabs that are already unloaded or are on the host whitelist.
		if (aTab.getAttribute("ontab") == "true") {
			return;
		}
		if (BarTabUtils.whiteListed(aTab.linkedBrowser.currentURI) || aTab.pinned) {
			return;
		}

		let tabbrowser = this.tabbrowser;

		// Make sure that we're not on this tab.  If we are, find the
		// closest tab that isn't on the bar tab.
		if (aTab.selected) {
			let activeTab = this.findClosestLoadedTab(aTab);
			if (activeTab) {
				tabbrowser.selectedTab = activeTab;
			}
		}

		var sessionstore = BarTabUtils.mSessionStore;
		var state = sessionstore.getTabState(aTab);
		var newtab = tabbrowser.addTab(null, {skipAnimation: true});

		// The user might not have 'extensions.bartab.loadRestoredTabs'
		// set to 1 but still wants to unload this tab.  That's why we
		// need to make sure we hook into the new tab before restoring
		// the tab state.
		if (newtab.getAttribute("ontab") != "true") {
			newtab.setAttribute("ontab", "true");
			(new BarTabWebProgressListener()).hook(newtab);
			(new BarTabWebNavigation()).hook(newtab);
		}

		// Move the new tab next to the one we're removing, but not in
		// front of it as that confuses Tree Style Tab.
		tabbrowser.moveTabTo(newtab, aTab._tPos + 1);

		tabbrowser.swapBrowsersAndCloseOther(aTab, newtab);
		sessionstore.setTabState(aTab, state);

		// Restore tree when using Tree Style Tab
		if (tabbrowser.treeStyleTab) {
			let parent = tabbrowser.treeStyleTab.getParentTab(aTab);
			if (parent) {
				tabbrowser.treeStyleTab.attachTabTo(newtab, parent,
					{dontAnimate: true, insertBefore: aTab.nextSibling});
			}
			let children = tabbrowser.treeStyleTab.getChildTabs(aTab);
			children.forEach(function (aChild) {
				tabbrowser.treeStyleTab.attachTabTo(
					aChild, newtab, {dontAnimate: true});
			});
		}
	},

	unloadOtherTabs: function (aTab) {
		var tabbrowser = this.tabbrowser;

		// Make sure we're sitting on the tab that isn't going to be unloaded.
		if (tabbrowser.selectedTab != aTab) {
			tabbrowser.selectedTab = aTab;
		}

		// unloadTab() mutates the tabs so the only sane thing to do is to
		// copy the list of tabs now and then work off that list.
		//
		// Which tab list to copy depends on the pref.
		var tabs = [];
		var tabSource = tabbrowser.mTabs;
		if (BarTabUtils.mPrefs.getBoolPref("extensions.bartab.unloadOnlyVisibleTabs")) {
			tabSource = tabbrowser.visibleTabs;
		}
		for (let i = 0; i < tabSource.length; i++) {
			tabs.push(tabSource[i]);
		}
		var self = this;
		tabs.forEach(function (tab) {
			if (tab != aTab) {
				self.unloadTab(tab);
			}
		});
	},

	toggleWhitelist: function (aTab) {
		var uri = aTab.linkedBrowser.currentURI;
		try {
			var host = uri.host;
		} catch (ex) {
			// Most likely uri.host doesn't exist.  Ignore then.
			return;
		}

		let whitelist = BarTabUtils.getWhitelist();
		let index = whitelist.indexOf(host);
		if (index == -1) {
			whitelist.push(host);
		} else {
			whitelist.splice(index, 1);
		}

		BarTabUtils.setWhitelist(whitelist);
	},

	/*
	 * In relation to a given tab, find the closest tab that is loaded.
	 * Note: if there's no such tab available, this will return unloaded
	 * tabs as a last resort.
	 */
	findClosestLoadedTab: function (aTab) {
		var visibleTabs = this.tabbrowser.visibleTabs;

		// Shortcut: if this is the only tab available, we're not going to
		// find another active one, are we...
		if (visibleTabs.length == 1) {
			return null;
		}

		// The most obvious choice would be the owner tab, if it's active and is
		// part of the same tab group.
		if (aTab.owner
			&& BarTabUtils.mPrefs.getBoolPref("browser.tabs.selectOwnerOnClose")
			&& aTab.owner.getAttribute("ontab") != "true") {
			let i = 0;
			while (i < visibleTabs.length) {
				if (visibleTabs[i] == aTab.owner) {
					return aTab.owner;
				}
				i++;
			}
		}

		// Otherwise walk the list of visible tabs and see if we can find an
		// active one.
		// To do that, first we need the index of the current tab in the visible-
		// tabs array.
		// However, if the current tab is being closed, it's already been removed
		// from that array. Therefore, we have to also accept its next-higher
		// sibling, if one is found. If one isn't, then the current tab was at
		// the end of the visible-tabs array, and the new end-of-array tab is the
		// best choice for a substitute index.
		let tabIndex = 0;
		while (tabIndex + 1 < visibleTabs.length &&
		visibleTabs[tabIndex] != aTab &&
		visibleTabs[tabIndex] != aTab.nextSibling) {
			// This loop will result in tabIndex pointing to one of three places:
			//    The current tab (visibleTabs[i] == aTab)
			//    The tab which had one index higher than the current tab, until the
			//      current tab was closed (visibleTabs[i] == aTab.nextSibling)
			//    The final tab in the array (tabIndex + 1 == visibleTabs.length)
			if (visibleTabs[tabIndex] == aTab.previousSibling) {
			}
			tabIndex++;
		}

		let i = 0;
		while ((tabIndex - i >= 0) ||
		(tabIndex + i < visibleTabs.length)) {
			let offsetIncremented = 0;
			if (tabIndex + i < visibleTabs.length) {
				if (visibleTabs[tabIndex + i].getAttribute("ontab") != "true" &&
					visibleTabs[tabIndex + i] != aTab) {
					// The '!= aTab' test is to rule out the case where i == 0 and
					// aTab is being unloaded rather than closed, so that tabIndex
					// points to aTab instead of its nextSibling.
					return visibleTabs[tabIndex + i];
				}
			}
			if (i == 0 && visibleTabs[tabIndex] != aTab) {
				// This is ugly, but should work.
				// If aTab has been closed, and nextSibling is unloaded, then we
				// have to check previousSibling before the next loop, or we'll take
				// nextSibling.nextSibling (if loaded) over previousSibling, which is
				// closer to the true "x.5" tabIndex offset.
				offsetIncremented = 1;
				i++;
			}
			if (tabIndex - i >= 0) {
				if (visibleTabs[tabIndex - i].getAttribute("ontab") != "true" &&
					visibleTabs[tabIndex - i] != aTab) {
					return visibleTabs[tabIndex - i];
				}
			}
			if (offsetIncremented > 0) {
				offsetIncremented = 0;
				i--;
			}
			i++;
		}

		// Fallback: there isn't an active tab available, so we're going
		// to have to nominate a non-active one.

		// Start with the owner, if appropriate.
		if (aTab.owner &&
			BarTabUtils.mPrefs.getBoolPref("browser.tabs.selectOwnerOnClose")) {
			let i = 0;
			while (i < visibleTabs.length) {
				if (visibleTabs[i] == aTab.owner) {
					return aTab.owner;
				}
				i++;
			}
		}
		// Otherwise, fall back to one of the adjacent tabs.
		if (tabIndex < visibleTabs.length &&
			visibleTabs[tabIndex] != aTab) {
			// aTab was closed, so the tab at its previous index is the correct
			// first choice
			return visibleTabs[tabIndex];
		}
		if (tabIndex + 1 < visibleTabs.length) {
			return visibleTabs[tabIndex + 1];
		}
		if (tabIndex - 1 >= 0) {
			return visibleTabs[tabIndex - 1];
		}

		// If we get this far, something's wrong. It shouldn't be possible for
		// there to not be an adjacent tab unless (visibleTabs.length == 1).
		Cu.reportError("BarTab: there are " + visibleTabs.length + " visible tabs, which is greater than 1, but no suitable tab was found from index " + tabIndex);
		return null;
	}
};


/*
 * A wrapping implementation of nsIWebNavigation.
 *
 * It can install itself as the webNavigation property of a tab's
 * browser object, replacing and wrapping around the original
 * implementation.  Once it has done so, it will defer all URI loading
 * until the tab is no longer marked as 'ontab'.
 *
 * This provides a new method on top of nsIWebNavigation called
 * 'resume()' which allows you to resume the operation that was
 * deferred.
 */
function BarTabWebNavigation() {
}
BarTabWebNavigation.prototype = {

	/*
	 * Install ourself as browser's webNavigation.  This needs to be
	 * passed the tab object (rather than just its associated browser
	 * object) because we need to be able to read and change tab's
	 * 'ontab' attribute.
	 */
	hook: function (aTab) {
		this._tab = aTab;
		this._original = aTab.linkedBrowser.webNavigation;

		var self = this;
		aTab.linkedBrowser.__defineGetter__('webNavigation', function () {
			return self;
		});
	},

	/*
	 * Restore the browser's original webNavigation.
	 */
	unhook: function () {
		if (this._tab._barTabProgressListener) {
			this._tab._barTabProgressListener.unhook();
		}

		delete this._gotoindex;
		delete this._loaduri_args;
		delete this._referringuri;

		if (this._tab.linkedBrowser.webNavigation === this) {
			// This will delete the instance getter for 'webNavigation',
			// thus revealing the original implementation.
			delete this._tab.linkedBrowser.webNavigation;
		}
		delete this._original;
		delete this._tab;
	},

	/*
	 * This will be replaced with either _resumeGotoIndex or _resumeLoadURI,
	 * unless it's a blank tab.  For the latter case we make sure we'll
	 * unhook ourselves.
	 */
	_resume: function () {
		this.unhook();
	},

	_unfakeDocshellURI: function () {
		// No longer lie about the URI.  Otherwise the docshell might
		// not want to load the page (especially seems to happen with
		// fragment URIs).
		var blankURI = BarTabUtils.makeURI("about:blank");
		this._tab.linkedBrowser.docShell.setCurrentURI(blankURI);
	},


	/*** Hook into gotoIndex() ***/

	gotoIndex: function (aIndex) {
		if (this._tab.getAttribute("ontab") == "true") {
			return this._pauseGotoIndex(aIndex);
		}
		return this._original.gotoIndex(aIndex);
	},

	_pauseGotoIndex: function (aIndex) {
		var history = this._original.sessionHistory;
		var entry = history.getEntryAtIndex(aIndex, false);
		if (BarTabUtils.whiteListed(entry.URI)) {
			this._tab.removeAttribute("ontab");
			return this._original.gotoIndex(aIndex);
		}

		this._tab.removeAttribute("busy");
		this._tab.label = entry.title;
		let window = this._tab.ownerDocument.defaultView;
		window.setTimeout(BarTabUtils.setIcon, 0, this._tab, entry.URI);

		// Fake the docshell's currentURI.  (This will also affect
		// window.location etc.)
		this._tab.linkedBrowser.docShell.setCurrentURI(entry.URI);
		this._referringuri = entry.referrerURI;

		this._gotoindex = aIndex;
		this._resume = this._resumeGotoIndex;
	},

	_resumeGotoIndex: function () {
		var index = this._gotoindex;
		var original = this._original;
		this._unfakeDocshellURI();
		this.unhook();
		return original.gotoIndex(index);
	},


	/*** Hook into loadURI() ***/

	/* A dirty hack. */
	loadURIWithOptions: function (aURI, aLoadFlags, aReferrer) {
		return this.loadURI(aURI, aLoadFlags, aReferrer, null, null);
	},

	loadURI: function (aURI) {
		// Allow about:blank to load without any side effects.
		if (aURI
			&& (aURI != "about:blank")
			&& (this._tab.getAttribute("ontab") == "true")) {
			return this._pauseLoadURI.apply(this, arguments);
		}
		return this._original.loadURI.apply(this._original, arguments);
	},

	_pauseLoadURI: function (aURI, aLoadFlags, aReferrer) {
		var uri = BarTabUtils.makeURI(aURI);
		if (BarTabUtils.whiteListed(uri)) {
			let original = this._original;
			this._tab.removeAttribute("ontab");
			this.unhook();
			return original.loadURI.apply(original, arguments);
		}

		// Stop BarTabWebProgressListener from creating an infinite loop.
		this._tab.setAttribute("ontab1", "true");

		// 2048 is LOAD_FLAGS_STOP_CONTENT
		this._original.loadURI.call(this._original, aURI, aLoadFlags | 2048, aReferrer, null, null);

		this._tab.removeAttribute("ontab1");

		this._tab.removeAttribute("busy");
		let window = this._tab.ownerDocument.defaultView;
		if (aReferrer) {
			// Fake the docshell's currentURI.  (This will also affect
			// window.location etc.)
			this._tab.linkedBrowser.docShell.setCurrentURI(uri);
			window.setTimeout(BarTabUtils.setTitleAndIcon, 0, this._tab, uri);
		} else {
			// If there's no referrer, it's likely that we were opened
			// from an external application which somehow sets up things
			// like tab title and currentURI later.  Avoid the race
			// with an increased timeout.
			window.setTimeout(this._tab.linkedBrowser.docShell.setCurrentURI,
				100, uri);
			window.setTimeout(BarTabUtils.setTitleAndIcon, 100, this._tab, uri);
		}

		if (aReferrer instanceof Ci.nsIURI) {
			this._referringuri = aReferrer.clone();
		}

		this._loaduri_args = arguments;
		this._resume = this._resumeLoadURI;
	},

	_resumeLoadURI: function () {
		var args = this._loaduri_args;
		var original = this._original;
		this._unfakeDocshellURI();
		this.unhook();
		return original.loadURI.apply(original, args);
	},


	/*** Behaviour changed for unloaded tabs. ***/

	get referringURI() {
		if (this._referringuri) {
			return this._referringuri.clone();
		}
		return this._original.currentURI;
	},

	reload: function (aReloadFlags) {
		if (this._tab.getAttribute("ontab") == "true") {
			this._tab.removeAttribute("ontab");
			//TODO should we patch aReloadFlags into this._loaduri_args?
			return this._resume();
		}
		return this._original.reload(aReloadFlags);
	},

	QueryInterface: function (aIID) {
		if (Ci.nsISupports.equals(aIID) || Ci.nsIWebNavigation.equals(aIID)) {
			return this;
		}
		return this._original.QueryInterface(aIID);
	},


	/*** These methods and properties are simply passed through. ***/

	setCurrentURI: function (aURI) {
		return this._original.setCurrentURI(aURI);
	},
	goBack: function () {
		return this._original.goBack();
	},
	goForward: function () {
		return this._original.goForward();
	},
	stop: function (aStopFlags) {
		return this._original.stop(aStopFlags);
	},
	get currentURI() {
		return this._original.currentURI;
	},
	get canGoBack() {
		return this._original.canGoBack;
	},
	get canGoForward() {
		return this._original.canGoForward;
	},
	get document() {
		return this._original.document;
	},
	get sessionHistory() {
		return this._original.sessionHistory;
	}
};


/*
 * Progress listener for tabs that are being restored but haven't
 * loaded yet.
 */
function BarTabRestoreProgressListener() {
}
BarTabRestoreProgressListener.prototype = {

	hook: function (aTab) {
		this._tab = aTab;
		aTab._barTabRestoreProgressListener = this;
		aTab.linkedBrowser.webProgress.addProgressListener(
			this, Ci.nsIWebProgress.NOTIFY_STATE_NETWORK);
	},

	unhook: function () {
		this._tab.linkedBrowser.webProgress.removeProgressListener(this);
		delete this._tab._barTabRestoreProgressListener;
		delete this._tab;
	},

	/*** nsIWebProgressListener ***/

	onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
		this._tab.removeAttribute("ontab");
		this.unhook();
	},
	onProgressChange: function () {
	},
	onLocationChange: function () {
	},
	onStatusChange: function () {
	},
	onSecurityChange: function () {
	},

	QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
		Ci.nsISupportsWeakReference,
		Ci.nsISupports])
};


/*
 * Progress listener that stops the loading of tabs that are opened in
 * the background and whose contents is loaded by C++ code.  This
 * occurs for instance when the 'browser.tabs.loadDivertedInBackground'
 * preference is enabled (because links are always opened by docshell code).
 */
function BarTabWebProgressListener() {
}
BarTabWebProgressListener.prototype = {

	hook: function (aTab) {
		this._tab = aTab;
		aTab._barTabProgressListener = this;
		aTab.linkedBrowser.webProgress.addProgressListener(
			this, Ci.nsIWebProgress.NOTIFY_ALL);
	},

	unhook: function () {
		this._tab.linkedBrowser.webProgress.removeProgressListener(this);
		delete this._tab._barTabProgressListener;
		delete this._tab;
	},

	/*** nsIWebProgressListener ***/

	onStateChange: function (aWebProgress, aRequest, aStateFlags, aStatus) {
		if (!aRequest) {
			return;
		}
		if (!(aStateFlags & Ci.nsIWebProgressListener.STATE_START)
			|| !(aStateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)
			|| (aStateFlags & Ci.nsIWebProgressListener.STATE_RESTORING)) {
			return;
		}
		if (this._tab.getAttribute("ontab") != "true") {
			return;
		}

		// Allow about:blank and wyciwyg URIs to load without any side effects.
		let uri = aRequest.QueryInterface(Ci.nsIChannel).URI;
		uri.QueryInterface(Components.interfaces.nsIURI);
		if ((uri.spec == "about:blank") || (uri.scheme == "wyciwyg") || (uri.scheme == "jar")) {
			return;
		}

		// Allow whitelisted URIs to load.
		let browser = this._tab.linkedBrowser;

		if (this._tab.getAttribute("ontab1") == "true") {
			browser.stop();

			return;
		}

		if (BarTabUtils.whiteListed(uri)) {
			this._tab.removeAttribute("ontab");
			// webNavigation.unhook() will call our unhook.
			browser.webNavigation.unhook();
			return;
		}

		// If it's an HTTP request, we want to set the right referrer.
		// And if it's a POST request on top of that, we want to make
		// sure we reuse the post data.
		let httpChannel;
		try {
			httpChannel = aRequest.QueryInterface(Ci.nsIHttpChannel);
		} catch (ex) {
			// Ignore.
		}

		let referrer;
		let postData;
		if (httpChannel) {
			referrer = httpChannel.referrer;
			let uploadChannel = httpChannel.QueryInterface(Ci.nsIUploadChannel);
			// uploadStream will be null or an nsIInputStream.
			postData = uploadChannel.uploadStream;
		}

		// Defer the loading.  Do this async so that other
		// nsIWebProgressListeners have a chance to update the UI
		// before _pauseLoadURI overwrites it all again.
		browser.stop();

		let flags = 0;
		let window = this._tab.ownerDocument.defaultView;
		window.setTimeout(function () {
			browser.webNavigation.loadURI(
				uri.spec, flags, referrer, postData, null);
		}, 0);
	},

	onProgressChange: function () {
	},
	onLocationChange: function () {
	},
	onStatusChange: function () {
	},
	onSecurityChange: function () {
	},

	QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
		Ci.nsISupportsWeakReference,
		Ci.nsISupports])
};


/*
 * A timer that keeps track of how long ago each tab was last visited.
 * If that time reaches a user-defined value, it unloads the tab in
 * question.  (The actual implementation works differently.  It uses
 * setTimeout, of course).
 */
function BarTabTimer() {
}
BarTabTimer.prototype = {

	init: function (aTabBrowser) {
		this.tabbrowser = aTabBrowser;
		aTabBrowser.tabContainer.addEventListener('TabOpen', this, false);
		aTabBrowser.tabContainer.addEventListener('TabSelect', this, false);
		aTabBrowser.tabContainer.addEventListener('TabClose', this, false);

		this.previousTab = null;
		this.selectedTab = aTabBrowser.selectedTab;
	},

	handleEvent: function (event) {
		switch (event.type) {
			case 'TabOpen':
				this.onTabOpen(event);
				return;
			case 'TabSelect':
				this.onTabSelect(event);
				return;
			case 'TabClose':
				this.onTabClose(event);
				return;
		}
	},

	onTabOpen: function (aEvent) {
		var tab = aEvent.originalTarget;
		if (tab.selected || BarTabUtils.getPref("loadBackgroundTabs")) {
			return;
		}
		this.startTimer(tab);
	},

	onTabClose: function (event) {
		this.clearTimer(event.originalTarget);
		if (event.originalTarget == this.selectedTab) {
			this.selectedTab = null;
		}
		;
		if (event.originalTarget == this.previousTab) {
			this.previousTab = null;
		}
		;
	},

	onTabSelect: function (event) {
		this.previousTab = this.selectedTab;
		this.selectedTab = event.originalTarget;

		if (this.previousTab) {
			// The previous tab may not be available because it has
			// been closed.
			this.startTimer(this.previousTab);
		}
		this.clearTimer(this.selectedTab);
	},

	startTimer: function (aTab) {
		if (!BarTabUtils.getPref("unloadAfterTimeout")) {
			return;
		}
		if (aTab.getAttribute("ontab") == "true") {
			return;
		}

		if (aTab._barTabTimer) {
			this.clearTimer(aTab);
		}
		let secs = BarTabUtils.getPref("timeoutValue")
			* BarTabUtils.getPref("timeoutUnit");
		let window = aTab.ownerDocument.defaultView;
		// Allow 'this' to leak into the inline function
		let self = this;
		aTab._barTabTimer = window.setTimeout(function () {
			// The timer will be removed automatically since
			// unloadTab() will close and replace the original tab.
			self.tabbrowser.BarTabHandler.unloadTab(aTab, self.tabbrowser);
		}, secs * 1000);
	},

	clearTimer: function (aTab) {
		var window = aTab.ownerDocument.defaultView;
		window.clearTimeout(aTab._barTabTimer);
		aTab._barTabTimer = null;
	}
};


var BarTabUtils = {

	/*
	 * Create a new URI object.
	 */
	makeURI: function (aURL, aOriginCharset, aBaseURI) {
		return this.mIO.newURI(aURL, aOriginCharset, aBaseURI);
	},

	/*
	 * Find and set the tab's favicon for a given URI.
	 */
	setIcon: function (aTab, aURI) {
		try {
			let iconURI = BarTabUtils.mFavicon.getFaviconForPage(aURI);
			aTab.setAttribute("image", iconURI.spec);
		} catch (ex) {
			// No favicon found.  Perhaps it's a URL with an anchor?
			// Firefox doesn't always store favicons for those.
			// See https://bugzilla.mozilla.org/show_bug.cgi?id=420605
			aURI = BarTabUtils.stripFragmentFromURI(aURI);
			if (aURI) {
				BarTabUtils.setIcon(aTab, aURI);
			}
		}
	},

	/*
	 * Set a tab's title and favicon given a URI by querying the history
	 * service.
	 */
	setTitleAndIcon: function (aTab, aURI) {
		// See if we have title, favicon in stock for it. This should
		// definitely work for restored tabs as they're in the history
		// database.
		let info = BarTabUtils.getInfoFromHistory(aURI);
		if (!info) {
			aTab.label = BarTabUtils.titleFromURI(aURI);
			return;
		}
		// Firefox cripples nsINavHistoryService entries for fragment links.
		// See https://bugzilla.mozilla.org/show_bug.cgi?id=503832
		// Try to work around that by stripping the fragment from the URI.
		if (!info.icon) {
			let uri = BarTabUtils.stripFragmentFromURI(aURI);
			if (uri) {
				let anchorinfo = BarTabUtils.getInfoFromHistory(uri);
				if (anchorinfo) {
					info = anchorinfo;
				}
			}
		}
		aTab.setAttribute("image", info.icon);
		if (info.title) {
			aTab.label = info.title;
		} else {
			aTab.label = BarTabUtils.titleFromURI(aURI);
		}
	},

	/*
	 * Strip the fragment from a URI.  Returns a new URI object, or null
	 * if the URI didn't contain a fragment.
	 */
	stripFragmentFromURI: function (aURI) {
		var anchor = aURI.path.indexOf('#');
		if (anchor == -1) {
			return null;
		}
		let uri = aURI.clone();
		uri.path = uri.path.substr(0, anchor);
		return uri;
	},

	/*
	 * Derive a title from a URI by stripping the protocol and potentially
	 * "www.", so "http://www.mozilla.org" would become "mozilla.org".
	 */
	titleFromURI: function (aURI) {
		try {
			let hostPort = aURI.hostPort;
			let path = aURI.path;
			if (hostPort.substr(0, 4) == "www.") {
				hostPort = hostPort.substr(4);
			}
			if (path == "/") {
				path = "";
			}
			return hostPort + path;
		} catch (ex) {
			// Most likely aURI.hostPort and aURI.path failed.
			// Let's handle this gracefully.
			return aURI.spec;
		}
	},

	/*
	 * Get information about a URI from the history service,
	 * e.g. title, favicon, ...
	 */
	getInfoFromHistory: function (aURI) {
		var history = BarTabUtils.mHistory;
		var options = history.getNewQueryOptions();
		options.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY;
		options.maxResults = 1;

		var query = history.getNewQuery();
		query.uri = aURI;

		var result = history.executeQuery(query, options);
		result.root.containerOpen = true;

		if (!result.root.childCount) {
			return null;
		}
		return result.root.getChild(0);
	},

	getPref: function (aPref, aDefaultValue) {
		let branch = BarTabUtils.mPrefBranch;
		switch (branch.getPrefType(aPref)) {
			case Ci.nsIPrefBranch.PREF_STRING:
				return branch.getComplexValue(aPref, Ci.nsISupportsString).data;
			case Ci.nsIPrefBranch.PREF_INT:
				return branch.getIntPref(aPref);
			case Ci.nsIPrefBranch.PREF_BOOL:
				return branch.getBoolPref(aPref);
			case Ci.nsIPrefBranch.PREF_INVALID:
				return aDefaultValue;
			default:
				// This should never happen.
				throw "Error getting pref " + aPref + "!\n";
		}
	},

	migratePrefs: function () {
		let branch = this.mPrefBranch;

		let version = branch.getIntPref("configVersion");

		try {
			if (branch.prefHasUserValue("migrated")) {
				if (branch.getBoolPref("migrated")) {
					version = 1;
				}

				branch.deleteBranch("migrated");
			}
		} catch (exception) {
			// Keep on truckin'.
		}

		if (version < 1) {
			try {
				// Grab the list of old pref names
				let oldBranch = BarTabUtils.mPrefs.getBranch("extensions.bartap.");
				let oldPrefNames = oldBranch.getChildList("", {});
				let value;

				for each (let pref in oldPrefNames) {
					try {
						switch (pref) {
							// findClosestLoadedTab
							case "findClosestUntappedTab":
								value = oldBranch.getBoolPref(pref);
								branch.setBoolPref("findClosestLoadedTab", value);
								break;

							// loadBackgroundTabs
							case "tapBackgroundTabs":
								value = oldBranch.getBoolPref(pref, true);
								branch.setBoolPref("loadBackgroundTabs", value);
								break;

							// loadOnSelectDelay
							case "loadOnSelect":
								value = oldBranch.getBoolPref(pref);
								if (value) {
									value = oldBranch.getIntPref("loadOnSelectDelay");
								}
								branch.setIntPref("loadOnSelectDelay", 0 + value);
								break;

							case "timeoutUnit":
							case "timeoutValue":
								value = oldBranch.getIntPref(pref);
								branch.setIntPref(pref, value);
								break;

							// unloadAfterTimeout
							case "tapAfterTimeout":
								value = oldBranch.getBoolPref(pref, true);
								branch.setBoolPref("unloadAfterTimeout", value);
								break;

							// whitelist
							case "hostWhitelist":
								value = oldBranch.getCharPref(pref);
								branch.setCharPref("whitelist", value);
								break;
						}
					} catch (exception) {
						// Keep on truckin'.
					}
				}
			} catch (exception) {
				// Keep on truckin'.
			}

			try {
				oldBranch.deleteBranch("");
			} catch (exception) {
				// Keep on truckin'.
			}
		}

		if (version < 2) {
			try {
				/* Seriously these are confusing, let's change it to a boolean and invert it.
				 * It appears the previous fork was attempting to change these to delays?
				 * If we choose to follow suit, we should change the preference name to include "delay" in the name.
				 */

				if (branch.prefHasUserValue("loadBackgroundTabs")) { // No need to check types; they're enforced by pref.js.
					branch.setBoolPref("loadBackgroundTabs", !branch.getBoolPref("loadBackgroundTabs"));
				}

				if (branch.prefHasUserValue("loadRestoredTabs") && branch.getPrefType("loadRestoredTabs") === Ci.nsIPrefBranch.PREF_BOOL) {
					branch.setBoolPref("loadRestoredTabs", !branch.getBoolPref("loadRestoredTabs"));
				}
			} catch (exception) {
				// Keep on truckin'.
			}
		}

		if (version < 3) {
			try {
				/*
				 * loadRestoredTabs does not appear to do anything. Remove it.
				 */
				if (branch.prefHasUserValue("loadRestoredTabs")) {
					branch.deleteBranch("loadRestoredTabs");
				}
			} catch (exception) {
				// Keep on truckin'.
			}
		}

		branch.setIntPref("configVersion", 3);
	},

	/*
	 * Check whether a URI is on the white list.
	 */
	whiteListed: function (aURI) {
		try {
			return (BarTabUtils.getWhitelist().indexOf(aURI.host) != -1);
		} catch (ex) {
			// Most likely gotouri.host failed, so it isn't on the white list.
			return false;
		}
	},

	/*
	 * It might seem more elegant to use a getter & setter here so you
	 * could just use this.whiteList or similar.  However, that would
	 * suggest this.whiteList would always return the same array and
	 * that mutations to it would be persisted.  Both are not the case.
	 */

	getWhitelist: function () {
		var whitelist = BarTabUtils.mPrefs.getCharPref(
			"extensions.bartab.whitelist");
		if (!whitelist) {
			return [];
		}
		return whitelist.split(";");
	},

	setWhitelist: function (whitelist) {
		BarTabUtils.mPrefs.setCharPref("extensions.bartab.whitelist",
			whitelist.join(";"));
	}

};

/*
 * Lazy getters for XPCOM services.  This is in analogy to
 * Services.jsm which is available in Firefox 4.
 */
XPCOMUtils.defineLazyGetter(BarTabUtils, "mPrefs", function () {
	return Cc["@mozilla.org/preferences-service;1"]
		.getService(Ci.nsIPrefService)
		.QueryInterface(Ci.nsIPrefBranch2);
});
XPCOMUtils.defineLazyGetter(BarTabUtils, "mPrefBranch", function () {
	return BarTabUtils.mPrefs.getBranch("extensions.bartab.")
		.QueryInterface(Ci.nsIPrefBranch2);
});
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mIO",
	"@mozilla.org/network/io-service;1",
	"nsIIOService");
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mSessionStore",
	"@mozilla.org/browser/sessionstore;1",
	"nsISessionStore");
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mHistory",
	"@mozilla.org/browser/nav-history-service;1",
	"nsINavHistoryService");
XPCOMUtils.defineLazyServiceGetter(BarTabUtils, "mFavicon",
	"@mozilla.org/browser/favicon-service;1",
	"nsIFaviconService");
