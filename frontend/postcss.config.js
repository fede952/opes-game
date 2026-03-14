// PostCSS is the CSS transformation pipeline that Vite runs on every .css file.
// These two plugins are the standard Tailwind CSS v3 setup:
//   1. tailwindcss  — generates utility classes based on tailwind.config.js
//   2. autoprefixer — adds vendor-prefixed equivalents (e.g. -webkit-) for
//                     browser compatibility, automatically
export default {
  plugins: {
    tailwindcss:  {},
    autoprefixer: {},
  },
};
