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
          bg: '#cbd5e1',
          surface: '#f1f5f9',
          input: '#ffffff',
          border: '#94a3b8',
          text: '#020617',
          textSecondary: '#1e293b',
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
