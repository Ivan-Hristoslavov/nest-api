/*
 * Language switching.
 *
 * The markup is written in Bulgarian and stays that way — Bulgarian is not a
 * translation here, it is the source. Every other language is a dictionary
 * keyed by the Bulgarian string, which is the one arrangement that cannot go
 * quietly out of date: change a sentence in the HTML and its translation stops
 * matching, so the page falls back to the source instead of showing last
 * month's wording in confident English.
 *
 * Switching reloads the page. That is deliberate rather than lazy: translating
 * in place means keeping every original string somewhere to translate *back*
 * from, and a reload starts from pristine Bulgarian markup every time. It also
 * gets `<html lang>` right before the first paint, which matters to screen
 * readers and to search engines.
 *
 * The legal pages and the operator screen are deliberately not translated. The
 * terms, the privacy notice and the data-processing page are written against
 * Bulgarian law and a machine translation of them would be a liability, not a
 * feature.
 */
(function () {
  'use strict';

  var STORAGE = 'priceguard.lang';

  /** The language the markup itself is written in. */
  var SOURCE = 'bg';

  /**
   * What is on offer, and what it calls itself.
   *
   * A language picker that lists languages in *your* language is useless to the
   * person who needs it, so each name is written in its own.
   */
  var LANGUAGES = [
    { code: 'bg', label: 'Български', short: 'BG' },
    { code: 'en', label: 'English', short: 'EN' },
  ];

  var dictionary = null;
  var current = SOURCE;

  /** Collapses whitespace, because HTML indentation is not part of the string. */
  function normalise(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * The translation of one string, or the string itself.
   *
   * Punctuation and surrounding spaces are preserved: the markup splits
   * sentences around <strong> tags, so a fragment often legitimately begins
   * with ", " or ends with a space, and eating those would run words together.
   */
  function translate(raw) {
    if (!dictionary) return raw;

    var trimmed = normalise(raw);
    if (!trimmed) return raw;

    var hit = dictionary[trimmed];
    if (hit === undefined) return raw;

    var leading = /^\s*/.exec(raw)[0];
    var trailing = /\s*$/.exec(raw)[0];
    return leading + hit + trailing;
  }

  /**
   * Elements whose text is code rather than language.
   *
   * `<code>` and `<pre>` are not on this list, deliberately. They hold the API
   * examples, and an English reader met with `curl https://вашият-домейн` has
   * been handed something they cannot type. Every key in a dictionary is a
   * whole Bulgarian phrase, so a bare identifier inside a code block matches
   * nothing and passes through untouched.
   */
  var OPAQUE = { SCRIPT: 1, STYLE: 1 };

  /** Screens that stay in the source language whatever is selected. */
  var UNTRANSLATED = ['view-terms', 'view-privacy', 'view-gdpr', 'view-operator'];

  function isExcluded(node) {
    for (var element = node.parentElement; element; element = element.parentElement) {
      if (OPAQUE[element.tagName]) return true;
      if (element.id && UNTRANSLATED.indexOf(element.id) !== -1) return true;
    }
    return false;
  }

  var TRANSLATABLE_ATTRIBUTES = ['placeholder', 'title', 'aria-label'];

  /** Rewrites every translatable string under `root`, in place. */
  function apply(root) {
    if (!dictionary) return;

    var scope = root || document.body;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var pending = [];

    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (!normalise(node.nodeValue) || isExcluded(node)) continue;

      var translated = translate(node.nodeValue);
      // Collected first and written afterwards: mutating the tree while a
      // TreeWalker is halfway through it is how nodes get visited twice.
      if (translated !== node.nodeValue) pending.push([node, translated]);
    }

    pending.forEach(function (entry) {
      entry[0].nodeValue = entry[1];
    });

    var elements = scope.querySelectorAll('[placeholder], [title], [aria-label]');

    Array.prototype.forEach.call(elements, function (element) {
      if (isExcluded(element)) return;

      TRANSLATABLE_ATTRIBUTES.forEach(function (name) {
        var value = element.getAttribute(name);
        if (!value) return;

        var translated = translate(value);
        if (translated !== value) element.setAttribute(name, translated);
      });
    });
  }

  /** The page's own metadata, which no tree walk reaches. */
  function applyDocumentMetadata() {
    if (!dictionary) return;

    document.title = translate(document.title);

    var description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', translate(description.content));
  }

  function stored() {
    try {
      return window.localStorage.getItem(STORAGE);
    } catch (error) {
      return null;
    }
  }

  /**
   * The language to start in.
   *
   * A stored choice always wins. Failing that the browser's own preference
   * decides, so a Greek buyer who lands on the site from a search result is not
   * met with Bulgarian and no obvious way out.
   */
  function preferred() {
    var choice = stored();
    if (choice && supports(choice)) return choice;

    var offered = (navigator.languages || [navigator.language || '']).map(function (tag) {
      return String(tag).slice(0, 2).toLowerCase();
    });

    for (var i = 0; i < offered.length; i += 1) {
      if (offered[i] === SOURCE) return SOURCE;
      if (supports(offered[i])) return offered[i];
    }

    return SOURCE;
  }

  function supports(code) {
    return LANGUAGES.some(function (language) {
      return language.code === code;
    });
  }

  function setLanguage(code) {
    if (!supports(code) || code === current) return;

    try {
      window.localStorage.setItem(STORAGE, code);
    } catch (error) {
      /* private mode: the choice lasts for this page only */
    }

    window.location.reload();
  }

  /**
   * Loads a dictionary and translates the page.
   *
   * Fetched rather than bundled so a visitor who wants Bulgarian — most of
   * them — never downloads a word of English. A failed fetch is not an error
   * worth showing: the page is already readable in the source language.
   */
  function boot() {
    var wanted = preferred();

    document.documentElement.lang = wanted;
    current = wanted;

    if (wanted === SOURCE) {
      markSwitcher();
      return Promise.resolve();
    }

    return fetch('/locales/' + wanted + '.json', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        dictionary = payload;
        applyDocumentMetadata();
        apply(document.body);
        markSwitcher();
        watchForNewContent();
      })
      .catch(function () {
        current = SOURCE;
        document.documentElement.lang = SOURCE;
        markSwitcher();
      });
  }

  /** Shows which language is active on every switcher on the page. */
  function markSwitcher() {
    var buttons = document.querySelectorAll('[data-lang]');

    Array.prototype.forEach.call(buttons, function (button) {
      var active = button.dataset.lang === current;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('tab-active', active);
      button.classList.toggle('text-slate-200', active);
      button.classList.toggle('text-slate-500', !active);
    });
  }

  /**
   * Keeps up with whatever the application renders later.
   *
   * Most of the interface is built as HTML strings in `app.js` long after the
   * first pass over the document has finished, so without this a translated
   * page reverts to Bulgarian the moment a table redraws. The observer is
   * disconnected while translating, because rewriting a text node is itself a
   * mutation and would otherwise call this straight back.
   */
  function watchForNewContent() {
    if (!dictionary || typeof MutationObserver === 'undefined') return;

    var observer = new MutationObserver(function (records) {
      var added = [];

      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes, function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) added.push(node);
          else if (node.nodeType === Node.TEXT_NODE && node.parentElement) added.push(node.parentElement);
        });
      });

      if (added.length === 0) return;

      observer.disconnect();
      added.forEach(apply);
      observer.observe(document.body, { childList: true, subtree: true });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-lang]');
    if (button) setLanguage(button.dataset.lang);
  });

  window.PG_I18N = {
    languages: LANGUAGES,
    get current() {
      return current;
    },
    t: translate,
    apply: apply,
    setLanguage: setLanguage,
    ready: boot(),
  };
})();
