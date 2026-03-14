/**
 * @file src/i18n/index.ts
 * @description i18next initialization — the full internationalization setup for Opes.
 *
 * ================================================================
 * WHAT IS i18n?
 * ================================================================
 *
 * "i18n" is a numeronym for "Internationalization":
 *   i + (18 letters) + n = i18n
 *
 * It is the process of designing software so it can be adapted to different
 * languages and regions WITHOUT requiring changes to the application's source code.
 * The companion concept "l10n" (Localization) is the actual process of adapting
 * the software for a specific locale (translating strings, formatting dates, etc.).
 *
 * For Opes, i18n means:
 *   - Every string shown to the player lives in a JSON file, not in JSX.
 *   - The language can change at runtime without a page reload.
 *   - Adding a new language requires four small steps — see supportedLanguages.ts.
 *
 * ================================================================
 * ARCHITECTURE: NAMESPACES
 * ================================================================
 *
 * As Opes grows, you will have hundreds of translatable strings. Keeping them
 * all in one flat file becomes unmanageable. Namespaces allow you to split
 * translations by feature area:
 *
 *   'common'    → Shared UI text: buttons, labels, navigation, welcome messages.
 *                 Example: t('common:welcome')  →  "Welcome to Opes!"
 *
 *   'game'      → In-game text: resource names, building types, action labels.
 *                 Example: t('game:resource.wheat')  →  "Wheat" / "Trigo" / "小麦"
 *
 *   'economy'   → Economic terms: marketplace, trading, currency descriptions.
 *                 Example: t('economy:currency.denarius')  →  "Denarius"
 *
 *   'errors'    → Error messages shown to the player.
 *                 Example: t('errors:insufficientGold')  →  "You don't have enough gold."
 *
 * Usage in components:
 *   const { t } = useTranslation('game');    // sets default namespace to 'game'
 *   t('resource.wheat')                      // looks in 'game' namespace
 *   t('common:welcome')                      // prefix overrides to 'common' namespace
 *
 * ================================================================
 * LANGUAGE DETECTION FLOW
 * ================================================================
 *
 * When the app loads, the LanguageDetector plugin determines the language by
 * checking sources in this order (first match wins):
 *
 *   1. 'localStorage' — Did the player previously select a language?
 *                        Stored under key 'opes_i18n_language'.
 *                        This is the HIGHEST priority: respects player choice.
 *
 *   2. 'navigator'    — What language does the player's browser report?
 *                        (e.g., 'es-MX' for Mexican Spanish → maps to 'es').
 *
 *   3. 'htmlTag'      — What is the <html lang="..."> attribute in index.html?
 *                        Last resort fallback — currently "en".
 *
 * If none of the above resolves to a supported language, we fall back to 'en'.
 *
 * ================================================================
 * LOADING STRATEGY: BUNDLED vs LAZY-LOADED
 * ================================================================
 *
 * CURRENT APPROACH (bundled):
 *   All locale files are imported directly and included in the JavaScript bundle.
 *   Pros: Instant language switching — no network request needed.
 *   Cons: Larger initial bundle size (all languages loaded even if unused).
 *   Best for: Small-to-medium translation files, limited number of languages.
 *
 * ALTERNATIVE (lazy-loaded via i18next-http-backend):
 *   Locale files are fetched from a server or CDN on demand.
 *   Pros: Smaller initial bundle, scales to 50+ languages easily.
 *   Cons: Language switch may show a brief loading state.
 *   Best for: Many languages, large translation files, games with 10+ locales.
 *
 * To switch to lazy loading: replace the 'resources' config below with
 * i18n.use(Backend) and configure { backend: { loadPath: '/locales/{{lng}}/{{ns}}.json' } }
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// --- Import all locale JSON files ---
// Vite bundles these files directly into the JS bundle (no network request at runtime).
// The namespace for all files is 'common' (our default namespace).
//
// HOW TO ADD A NEW LANGUAGE (step 3 of 4):
//   Add the import here, following the same naming pattern.
//   The variable name convention is: {languageCode}Translations
//
// ── Original 6 languages ────────────────────────────────────────────────────
import enTranslations from './locales/en.json';
import esTranslations from './locales/es.json';
import zhTranslations from './locales/zh.json';
import deTranslations from './locales/de.json';
import frTranslations from './locales/fr.json';
import itTranslations from './locales/it.json';
// ── New languages ────────────────────────────────────────────────────────────
import ptTranslations from './locales/pt.json';
import ruTranslations from './locales/ru.json';
import plTranslations from './locales/pl.json';
import jaTranslations from './locales/ja.json';
import koTranslations from './locales/ko.json';
import trTranslations from './locales/tr.json';
import idTranslations from './locales/id.json';
import hiTranslations from './locales/hi.json';
// ── Add future language imports below this line ──────────────────────────────

/**
 * Initialize i18next. This is called once as a side effect when this module
 * is imported (in main.tsx). The configured i18next singleton is then accessed
 * by all useTranslation() hooks throughout the component tree.
 *
 * We use the 'void' operator because i18n.init() returns a Promise. We don't
 * need to await it here (the initialization is synchronous for bundled resources),
 * but we acknowledge the Promise explicitly to satisfy TypeScript's strict mode.
 */
void i18n
  /**
   * Plugin 1: LanguageDetector
   * Automatically detects and caches the user's preferred language.
   * Must be registered BEFORE initReactI18next.
   */
  .use(LanguageDetector)

  /**
   * Plugin 2: initReactI18next
   * Integrates i18next with React's Context API. This allows the i18next
   * instance to propagate language changes to all subscribed components
   * simultaneously, triggering a re-render with new translations.
   */
  .use(initReactI18next)

  .init({
    /**
     * Translation resources registry.
     * Structure: { [languageCode]: { [namespace]: translationsObject } }
     *
     * Each language code maps to its namespace(s). We start with 'common'
     * for all languages, following the namespace architecture described above.
     */
    resources: {
      // ── Original 6 languages ──────────────────────────────────────────────
      en: { common: enTranslations },
      es: { common: esTranslations },
      zh: { common: zhTranslations },
      de: { common: deTranslations },
      fr: { common: frTranslations },
      it: { common: itTranslations },
      // ── New languages ─────────────────────────────────────────────────────
      pt: { common: ptTranslations },
      ru: { common: ruTranslations },
      pl: { common: plTranslations },
      ja: { common: jaTranslations },
      ko: { common: koTranslations },
      tr: { common: trTranslations },
      id: { common: idTranslations },
      hi: { common: hiTranslations },
      // ── HOW TO ADD A NEW LANGUAGE (step 4 of 4) ───────────────────────────
      // Add: {code}: { common: {code}Translations },
      // Make sure the code matches exactly what is in supportedLanguages.ts
      // and what you imported above (step 3).
    },

    /**
     * The default namespace used when no namespace prefix is given.
     * t('welcome') is equivalent to t('common:welcome').
     */
    defaultNS: 'common',

    /**
     * The language to fall back to if a translation key is missing in the
     * currently active language.
     *
     * Example: if the German ('de') locale is missing a key that was just
     * added to English ('en'), German users will see the English text
     * rather than the raw key string (e.g., "common.newFeatureLabel").
     * This prevents a broken UI while the translation team catches up.
     */
    fallbackLng: 'en',

    /**
     * Enable debug logging during development to catch missing translation keys.
     * Set to true if you're adding new translation keys and want to verify
     * all namespaces/languages have been updated.
     * IMPORTANT: Disable in production — it clutters the browser console.
     */
    debug: false,

    interpolation: {
      /**
       * React already escapes JSX string values to prevent XSS attacks
       * (e.g., it converts <script> to &lt;script&gt; automatically).
       * Setting escapeValue to false prevents i18next from ALSO escaping values,
       * which would cause double-escaping (& becomes &amp; becomes &amp;amp;).
       *
       * SECURITY NOTE: This is safe because React handles escaping for us.
       * Only set this to 'true' if you are rendering translations as raw HTML
       * (using dangerouslySetInnerHTML), in which case you MUST also sanitize
       * the translation strings for XSS safety.
       */
      escapeValue: false,
    },

    /**
     * Language detector configuration.
     * Controls how the LanguageDetector plugin searches for and stores
     * the user's language preference.
     */
    detection: {
      /**
       * The order in which detection sources are checked.
       * 'localStorage' is first so manually chosen languages are always respected.
       */
      order: ['localStorage', 'navigator', 'htmlTag'],

      /**
       * The localStorage key where the selected language code is persisted.
       * Example: localStorage.getItem('opes_i18n_language') === 'es'
       * We use a game-specific key to avoid conflicts with other apps.
       */
      lookupLocalStorage: 'opes_i18n_language',

      /**
       * After detection, automatically save the resolved language to the
       * caches listed here. This ensures that on the next visit, the same
       * language is shown without re-detecting from the browser.
       */
      caches: ['localStorage'],
    },
  });

export default i18n;
