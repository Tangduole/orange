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
          bg: '#f8fafc',
          surface: '#ffffff',
          input: '#f1f5f9',
          border: '#e2e8f0',
          text: '#1e293b',
          textSecondary: '#475569',
          textMuted: '#94a3b8',
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
