/** @type {import('tailwindcss').Config} */
export default {
  // Tell Tailwind which files to scan for class names.
  // It will strip any class it doesn't find here, so keep this accurate.
  content: ['./src/**/*.{tsx,ts,jsx,js,html}'],

  theme: {
    extend: {
      // ----------------------------------------------------------------
      // Custom "Ancient Rome" palette
      // Use these as: bg-roman-gold, text-roman-purple, border-roman-marble, etc.
      // ----------------------------------------------------------------
      colors: {
        'roman-gold':   '#D4AF37',
        'roman-purple': '#5E2129',
        'roman-marble': '#F2F0E6',
        'roman-dark':   '#2C2A29',
      },

      // Georgia serif is already web-safe; extend Tailwind's font stack so
      // we can use `font-roman` instead of an ad-hoc inline style.
      fontFamily: {
        roman: ['Georgia', 'serif'],
      },
    },
  },

  plugins: [],
};
