/**
 * @file src/components/LanguageSelector.tsx
 * @description A reusable UI component that lets players switch the application language.
 *
 * ================================================================
 * DESIGN PRINCIPLES
 * ================================================================
 *
 * 1. SINGLE RESPONSIBILITY
 *    This component does ONE thing: display the available languages and
 *    trigger a language change when the player selects one. It does not
 *    manage translation strings, load locale files, or persist anything.
 *    All of that is handled by i18next (configured in src/i18n/index.ts).
 *
 * 2. OPEN/CLOSED PRINCIPLE
 *    The component is "open for extension, closed for modification".
 *    You can customize its behavior by passing props (e.g., a custom
 *    'languages' list or an 'onLanguageChange' callback) WITHOUT editing
 *    this file. For most use cases, you can drop it in with zero props.
 *
 * 3. SINGLE SOURCE OF TRUTH FOR THE LANGUAGE LIST
 *    The list of languages comes from src/i18n/supportedLanguages.ts.
 *    That file is also imported by src/i18n/index.ts. This means you
 *    only need to update ONE file when adding a language, and both the
 *    i18n system and this component stay in sync automatically.
 *
 * 4. ACCESSIBILITY FIRST
 *    We use a native HTML <select> element instead of a custom-styled
 *    button list because:
 *      - It is natively keyboard-navigable (Tab, arrow keys, Enter).
 *      - Screen readers announce it correctly as a "combobox" / "listbox".
 *      - It scales to any number of languages without layout issues.
 *      - It renders appropriately on mobile devices as a native picker.
 *    A custom styled dropdown can be built on top later without changing
 *    the component's logic.
 *
 * ================================================================
 * HOW TO ADD A NEW LANGUAGE — QUICK REFERENCE
 * ================================================================
 *
 * You do NOT need to edit this file to add a language. Instead:
 *
 *   1. Add the language entry to SUPPORTED_LANGUAGES in:
 *      src/i18n/supportedLanguages.ts
 *
 *   2. Create the translation file:
 *      src/i18n/locales/{languageCode}.json
 *      (copy en.json as a template, translate only the values)
 *
 *   3. Import and register it in:
 *      src/i18n/index.ts
 *
 * The selector will automatically include the new language —
 * no changes needed in this file.
 *
 * ================================================================
 * USAGE EXAMPLES
 * ================================================================
 *
 * Basic usage (uses all 14 supported languages):
 *   <LanguageSelector />
 *
 * Render only a subset (e.g., for a regional product):
 *   <LanguageSelector languages={[
 *     { code: 'en', label: 'English' },
 *     { code: 'es', label: 'Español' },
 *   ]} />
 *
 * With a layout class from a CSS module or Tailwind:
 *   <LanguageSelector className={styles.languagePicker} />
 *
 * With a callback to run custom logic after language change:
 *   <LanguageSelector onLanguageChange={(code) => console.log('Changed to:', code)} />
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  SUPPORTED_LANGUAGES,
  type LanguageOption,
} from '../i18n/supportedLanguages';

// ================================================================
// PROPS TYPE DEFINITION
// ================================================================

/**
 * Props accepted by the LanguageSelector component.
 *
 * All props are optional — the component works out of the box with zero config.
 */
interface LanguageSelectorProps {
  /**
   * The list of languages to display in the selector.
   *
   * Defaults to SUPPORTED_LANGUAGES from src/i18n/supportedLanguages.ts.
   * Override this to show only a subset of languages in a specific context.
   *
   * IMPORTANT: Every code in this list must be registered in src/i18n/index.ts.
   * If a code is listed here but not in i18next resources, selecting it will
   * display English text (the fallback language) with no error thrown.
   */
  languages?: LanguageOption[];

  /**
   * An optional CSS class name applied to the outermost <div> wrapper.
   *
   * This is the recommended way to style the component from outside.
   * Examples:
   *   - Plain CSS:   className="language-selector"
   *   - CSS Modules: className={styles.languageSelector}
   *   - Tailwind:    className="flex items-center gap-2"
   */
  className?: string;

  /**
   * An optional callback invoked AFTER a language change has been triggered.
   *
   * Useful when the parent component needs to react to a language change
   * (e.g., update a user profile setting via an API call, log an analytics event).
   *
   * @param languageCode - The BCP 47 code of the newly selected language.
   *
   * @example
   * <LanguageSelector
   *   onLanguageChange={(code) => {
   *     fetch('/api/v1/me/preferences', {
   *       method: 'PATCH',
   *       body: JSON.stringify({ language: code }),
   *     });
   *   }}
   * />
   */
  onLanguageChange?: (languageCode: string) => void;
}

// ================================================================
// COMPONENT
// ================================================================

/**
 * LanguageSelector — a self-contained language switching control.
 *
 * Reads the active language from i18next and renders a <select> dropdown
 * populated with all (or a subset of) supported languages.
 */
const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  languages = SUPPORTED_LANGUAGES,
  className,
  onLanguageChange,
}) => {
  /**
   * useTranslation() gives us access to the i18next instance.
   * We only need 'i18n' here (not 't'), since this component does not
   * render any translated text — it only controls the active language.
   *
   * When i18n.changeLanguage() is called, ALL other components using
   * useTranslation() across the entire app will re-render automatically
   * with the new language's strings.
   */
  const { i18n } = useTranslation();

  /**
   * Resolve the currently active language code for the <select> value.
   *
   * WHY i18n.resolvedLanguage INSTEAD OF i18n.language?
   * The browser language detector may set i18n.language to a regional code
   * like 'en-US' or 'pt-BR', but our locale files are registered under the
   * base codes 'en' and 'pt'.  i18next resolves 'en-US' → 'en' internally
   * and exposes that resolved value as i18n.resolvedLanguage, which is what
   * we should compare against.  i18n.language still holds the raw detected
   * string, so startsWith('en') would work in that case — but
   * resolvedLanguage is the canonical, post-resolution value and is always
   * the safest source of truth.
   *
   * WHY SEARCH `languages` (THE PROP) INSTEAD OF `SUPPORTED_LANGUAGES`?
   * The component accepts an optional `languages` prop that callers can use
   * to render only a subset of locales (e.g., a regional build).  If we
   * searched the global SUPPORTED_LANGUAGES constant but rendered options
   * from the prop, activeCode could resolve to a value that has no matching
   * <option>, causing the browser to silently show the first option (English)
   * regardless of the actual active language.  Searching the same array that
   * produces the <option> elements guarantees they always stay in sync.
   */
  const activeCode: string =
    languages.find(
      (lang) => (i18n.resolvedLanguage ?? i18n.language).startsWith(lang.code)
    )?.code ?? 'en';

  /**
   * Handles the native <select> change event.
   *
   * We call i18n.changeLanguage() which:
   *   1. Updates i18next's internal language state.
   *   2. Looks up the resources registered for the new language.
   *   3. Triggers a re-render of every component using useTranslation().
   *   4. Persists the selection to localStorage (configured in i18n/index.ts).
   *
   * The 'void' prefix discards the returned Promise intentionally.
   * We don't need to await it — for bundled resources, the switch is
   * effectively synchronous. For lazy-loaded resources, add a loading
   * state here if you want to show a spinner during the network request.
   */
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const selectedCode = event.target.value;
    void i18n.changeLanguage(selectedCode);
    onLanguageChange?.(selectedCode); // Call the optional parent callback if provided
  };

  /**
   * Builds the display string for a single <option>.
   *
   * Combines the native label with the optional region in parentheses.
   * Examples:
   *   { label: 'English' }                   → "English"
   *   { label: 'Português', region: 'Brasil' } → "Português (Brasil)"
   */
  const formatOptionLabel = (lang: LanguageOption): string =>
    lang.region ? `${lang.label} (${lang.region})` : lang.label;

  return (
    /*
     * The wrapper <div> receives the optional className for external styling.
     * It uses a minimal inline style only to arrange the label and select
     * side-by-side — nothing that would clash with a real design system.
     */
    <div
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
    >
      {/*
       * The <label> is associated with the <select> via the htmlFor/id pair.
       * This is critical for accessibility: clicking the label focuses the
       * dropdown, and screen readers announce "Language" before the control.
       *
       * NOTE: "Language" is intentionally left in English and NOT run through
       * the translation function t(). This is the language selector itself —
       * if the player is on a language they don't understand, the word
       * "Language" in English is a universal fallback that helps them find
       * the control to switch back.
       */}
      <label
        htmlFor="opes-language-selector"
        style={{ fontSize: '0.85rem', color: '#555', whiteSpace: 'nowrap' }}
      >
        Language:
      </label>

      <select
        id="opes-language-selector"
        value={activeCode}
        onChange={handleChange}
        aria-label="Select application language"
        style={{
          /**
           * Minimal functional styling only.
           * A future design pass can replace these with CSS classes.
           * The 'cursor: pointer' is a small UX improvement that signals
           * to the player that this element is interactive.
           */
          padding:      '4px 8px',
          borderRadius: '4px',
          border:       '1px solid #ccc',
          cursor:       'pointer',
          fontSize:     '0.9rem',
        }}
      >
        {languages.map((lang) => (
          /**
           * Each <option>'s value is the BCP 47 language code.
           * This is what gets passed to i18n.changeLanguage() on selection.
           *
           * The key prop uses lang.code — a stable, unique identifier.
           * We never use array indices as React keys because reordering
           * the SUPPORTED_LANGUAGES array would cause React to re-render
           * all options unnecessarily.
           */
          <option key={lang.code} value={lang.code}>
            {formatOptionLabel(lang)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default LanguageSelector;
