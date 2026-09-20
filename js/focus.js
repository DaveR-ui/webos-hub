/*
 * WebOS Hub - D-pad spatial navigation.
 *
 * The webOS TV remote emits keyCode 37/38/39/40 (arrows), 13 (OK) and
 * 461 or 10009 (Back). Arrow navigation is geometric: from the currently
 * focused element we pick the nearest focusable element in the requested
 * direction instead of following DOM/tab order.
 *
 * Focus is expressed as the `.focused` CSS class so that the ring survives even
 * when the browser's native focus is lost (common inside webOS webviews).
 */
(function (global) {
	'use strict';

	var KEY_LEFT = 37;
	var KEY_UP = 38;
	var KEY_RIGHT = 39;
	var KEY_DOWN = 40;
	var KEY_ENTER = 13;
	var KEY_BACK = 461;
	/* Several webOS remotes emit 10009 for Back instead of 461. */
	var KEY_BACK_ALT = 10009;
	var KEY_BACKSPACE = 8;
	var KEY_SPACE = 32;

	var FOCUSABLE_SELECTOR = '[data-focusable="true"]';
	/* Cross-axis displacement is penalised so we prefer to stay in a row. */
	var CROSS_AXIS_WEIGHT = 4;
	/* Allowed misalignment before an element counts as "beside" the cursor. */
	var TOLERANCE = 8;

	var current = null;
	var options = {};
	var bound = false;

	function isVisible(el) {
		if (!el || typeof el.getBoundingClientRect !== 'function') {
			return false;
		}
		if (el.hasAttribute('disabled')) {
			return false;
		}
		if (el.closest && el.closest('[hidden]')) {
			return false;
		}
		var rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) {
			return false;
		}
		var style = global.getComputedStyle(el);
		if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
			return false;
		}
		return true;
	}

	function candidates() {
		var nodes;
		try {
			nodes = global.document.querySelectorAll(FOCUSABLE_SELECTOR);
		} catch (e) {
			return [];
		}
		var out = [];
		for (var i = 0; i < nodes.length; i++) {
			if (isVisible(nodes[i])) {
				out.push(nodes[i]);
			}
		}
		return out;
	}

	function centerOf(el) {
		var r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}

	/*
	 * Returns a cost for reaching `candidate` from `from` moving in `dir`, or
	 * null when the candidate is not in that direction.
	 */
	function directionCost(candidate, from, dir) {
		var c = centerOf(candidate);
		var dx = c.x - from.x;
		var dy = c.y - from.y;
		var primary;
		var secondary;

		if (dir === 'left') {
			if (dx > -TOLERANCE) { return null; }
			primary = -dx;
			secondary = Math.abs(dy);
		} else if (dir === 'right') {
			if (dx < TOLERANCE) { return null; }
			primary = dx;
			secondary = Math.abs(dy);
		} else if (dir === 'up') {
			if (dy > -TOLERANCE) { return null; }
			primary = -dy;
			secondary = Math.abs(dx);
		} else {
			if (dy < TOLERANCE) { return null; }
			primary = dy;
			secondary = Math.abs(dx);
		}
		return primary + (secondary * CROSS_AXIS_WEIGHT);
	}

	function focus(el) {
		if (!el || !isVisible(el)) {
			return false;
		}
		if (current && current !== el && current.classList) {
			current.classList.remove('focused');
		}
		current = el;
		if (el.classList) {
			el.classList.add('focused');
		}
		try {
			if (typeof el.focus === 'function') {
				el.focus();
			}
		} catch (e) { /* focus may be rejected; the .focused class still applies */ }
		scrollIntoView(el);
		return true;
	}

	function scrollIntoView(el) {
		try {
			if (typeof el.scrollIntoView === 'function') {
				el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
		} catch (e) {
			try {
				if (typeof el.scrollIntoView === 'function') {
					el.scrollIntoView(false);
				}
			} catch (e2) { /* ignore */ }
		}
	}

	function focusFirst() {
		var list = candidates();
		if (!list.length) {
			return false;
		}
		var preferred = null;
		for (var i = 0; i < list.length; i++) {
			if (list[i].getAttribute('data-autofocus') === 'true') {
				preferred = list[i];
				break;
			}
		}
		return focus(preferred || list[0]);
	}

	function move(dir) {
		if (!current || !isVisible(current)) {
			return focusFirst();
		}
		var from = centerOf(current);
		var list = candidates();
		var best = null;
		var bestCost = Infinity;
		for (var i = 0; i < list.length; i++) {
			if (list[i] === current) {
				continue;
			}
			var cost = directionCost(list[i], from, dir);
			if (cost !== null && cost < bestCost) {
				bestCost = cost;
				best = list[i];
			}
		}
		if (best) {
			return focus(best);
		}
		return false;
	}

	function activate() {
		if (!current) {
			return false;
		}
		if (typeof current.click === 'function') {
			current.click();
			return true;
		}
		return false;
	}

	function isTextInput(target) {
		if (!target || !target.tagName) {
			return false;
		}
		var tag = String(target.tagName).toUpperCase();
		return tag === 'INPUT' || tag === 'TEXTAREA';
	}

	/* Runs the app's Back handler; returns true when the app consumed the key. */
	function handleBack() {
		if (typeof options.onBack === 'function') {
			/* false means "let the platform exit". */
			return options.onBack() !== false;
		}
		return false;
	}

	function onKeyDown(evt) {
		var code = evt.keyCode;
		var handled = true;

		/*
		 * Inside a text field the platform owns the editing keys: Backspace,
		 * Space and the arrows must move the caret / selection, so we let them
		 * through untouched (no preventDefault). Only Enter (submit-ish) and the
		 * Back key are still handled by the app.
		 */
		if (isTextInput(evt.target)) {
			if (code === KEY_ENTER) {
				activate();
			} else if (code === KEY_BACK || code === KEY_BACK_ALT) {
				handled = handleBack();
			} else {
				return false;
			}
			if (handled) {
				evt.preventDefault();
				evt.stopPropagation();
			}
			return handled;
		}

		if (code === KEY_LEFT) {
			move('left');
		} else if (code === KEY_UP) {
			move('up');
		} else if (code === KEY_RIGHT) {
			move('right');
		} else if (code === KEY_DOWN) {
			move('down');
		} else if (code === KEY_ENTER || code === KEY_SPACE) {
			activate();
		} else if (code === KEY_BACK || code === KEY_BACK_ALT || code === KEY_BACKSPACE) {
			/* The app decides what Back means; false means "let the platform exit". */
			if (!handleBack()) {
				handled = false;
			}
		} else {
			handled = false;
		}

		if (handled) {
			evt.preventDefault();
			evt.stopPropagation();
		}
		return handled;
	}

	/* Mouse/touch support so desktop-browser development stays usable. */
	function onClick(evt) {
		var target = evt.target;
		if (!target || !target.closest) {
			return;
		}
		var el = target.closest(FOCUSABLE_SELECTOR);
		if (el) {
			focus(el);
		}
	}

	function init(opts) {
		options = opts || {};
		if (!bound) {
			global.document.addEventListener('keydown', onKeyDown, true);
			global.document.addEventListener('click', onClick, true);
			bound = true;
		}
		focusFirst();
	}

	/* Call after re-rendering so focus never stays on a removed element. */
	function refresh() {
		if (current && global.document.body && global.document.body.contains(current) && isVisible(current)) {
			return true;
		}
		current = null;
		return focusFirst();
	}

	function getCurrent() {
		return current;
	}

	function blur() {
		if (current && current.classList) {
			current.classList.remove('focused');
		}
		current = null;
	}

	global.HubFocus = {
		init: init,
		refresh: refresh,
		focus: focus,
		focusFirst: focusFirst,
		getCurrent: getCurrent,
		blur: blur
	};
})(window);
