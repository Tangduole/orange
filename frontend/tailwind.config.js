/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        orange: {
          DEFAULT: '#F97316',
          light: '#FB923C',
          dark: '#EA580C',
        },
        cyan: {
          DEFAULT: '#22D3EE',
          light: '#67E8F9',
          dark: '#06B6D4',
        },
        dark: {
          bg: '#0f172a',
          surface: '#1e293b',
          input: '#334155',
          border: '#475569',
        },
        light: {
          bg: '#dce3eb',
          surface: '#eef2f6',
          input: '#e2e8f0',
          border: '#cbd5e1',
          text: '#0f172a',
          textSecondary: '#334155',
          textMuted: '#475569',
        },
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
      }
    },
  },
  plugins: [],
}
