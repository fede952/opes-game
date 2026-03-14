/**
 * @file src/i18n/supportedLanguages.ts
 * @description The single source of truth for every language Opes supports.
 *
 * ================================================================
 * WHY A SEPARATE FILE FOR THE LANGUAGE LIST?
 * ================================================================
 *
 * Both the i18n configuration (index.ts) and the UI component (LanguageSelector)
 * need to know which languages exist. Without this file, the list would be
 * duplicated — defined once in index.ts and again in the component. Keeping
 * two lists in sync is error-prone: you might add a language to i18next but
 * forget to add it to the dropdown (or vice versa).
 *
 * By exporting the list from here, BOTH files import from this single location.
 * When you add a new language, you update this file and the component UI
 * automatically includes it — no component code changes needed.
 *
 * ================================================================
 * HOW TO ADD A NEW LANGUAGE — A JUNIOR DEVELOPER'S GUIDE
 * ================================================================
 *
 * Adding a language to Opes requires exactly FOUR steps:
 *
 * STEP 1 — Add an entry to the SUPPORTED_LANGUAGES array below.
 *           Provide the BCP 47 code, the native label, and optionally
 *           a region string (e.g., 'Brazil' to distinguish pt-BR from pt-PT).
 *
 *           Example — adding Arabic:
 *             { code: 'ar', label: 'العربية', region: 'عالمي' }
 *
 * STEP 2 — Create the translation JSON file.
 *           Path: src/i18n/locales/{code}.json
 *           Copy en.json as a template and translate every value.
 *           IMPORTANT: Do NOT translate the JSON keys — only the values.
 *           The keys (e.g., "welcome", "subtitle") must stay in English
 *           because they are used by the application code.
 *
 * STEP 3 — Import the new JSON file in src/i18n/index.ts:
 *           import arTranslations from './locales/ar.json';
 *
 * STEP 4 — Register it in the i18next resources object in src/i18n/index.ts:
 *           ar: { common: arTranslations },
 *
 * That is all. The LanguageSelector component, the language detection,
 * and the fallback system will all pick up the new language automatically.
 *
 * ================================================================
 * WHAT IS A BCP 47 LANGUAGE CODE?
 * ================================================================
 *
 * BCP 47 is the standard format for language tags, used by browsers,
 * i18next, and HTML's lang attribute. The format is:
 *
 *   {language}[-{Script}][-{REGION}]
 *
 *   'en'       → English (no region — applies to all English variants)
 *   'en-US'    → English as used in the United States
 *   'en-GB'    → English as used in Great Britain
 *   'pt'       → Portuguese (no region)
 *   'pt-BR'    → Portuguese as used in Brazil
 *   'zh-Hans'  → Chinese written in Simplified script
 *   'zh-Hant'  → Chinese written in Traditional script
 *
 * For Opes, we use the base language code (e.g., 'pt', not 'pt-BR') unless
 * we need to distinguish between regional variants of the same language.
 * The 'region' field in the LanguageOption type is only for UI display purposes.
 */

/**
 * Defines the shape for a single language entry in the supported list.
 *
 * Exporting this type allows other files (e.g., LanguageSelector.tsx) to
 * strongly type their props and variables against it, preventing type errors.
 */
export interface LanguageOption {
  /**
   * The BCP 47 language code used by i18next to identify the language.
   * Must exactly match the key registered in the i18next resources object.
   * Example: 'en', 'es', 'pt', 'zh'
   */
  code: string;

  /**
   * The name of the language written in that language itself (endonym).
   * We use the native name — NOT the English name — so players can always
   * find their own language even if the current UI is in a language they
   * don't understand. For example, 'Русский' instead of 'Russian'.
   */
  label: string;

  /**
   * Optional display label for the region or variant.
   * Shown in parentheses in the UI: "Português (Brasil)".
   * Only needed when multiple variants of the same language are supported
   * (e.g., Brazilian vs. European Portuguese).
   */
  region?: string;
}

/**
 * The complete list of languages available in Opes.
 *
 * This array is the authoritative source for:
 *   1. The LanguageSelector component — renders one <option> per entry.
 *   2. Any other UI that needs to enumerate available languages.
 *
 * The i18next resources registration in src/i18n/index.ts must have an
 * entry for EVERY code listed here — otherwise the selector will show
 * a language that has no translations, causing fallbacks to English.
 *
 * Languages are ordered by approximate global speaker count (descending)
 * to ensure the most common languages appear first in the dropdown.
 * Feel free to reorder as needed for your target audience.
 */
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  // ── Original 6 languages ─────────────────────────────────────
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'pt', label: 'Português', region: 'Brasil' },

  // ── New languages ─────────────────────────────────────────────
  { code: 'ru', label: 'Русский' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'it', label: 'Italiano' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'pl', label: 'Polski' },

  // ── Add future languages below this line ──────────────────────
  // { code: 'ar', label: 'العربية' },
  // { code: 'nl', label: 'Nederlands' },
  // { code: 'sv', label: 'Svenska' },
];
