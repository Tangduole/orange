/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        orange: {
          DEFAULT: '#FF7D00',
          light: '#FFA347',
          dark: '#E56E00',
        },
        dark: {
          bg: '#121212',
          surface: '#1E1E1E',
          input: '#2C2C2C',
          border: '#3A3A3A',
        },
        light: {
          bg: '#FAFAF8',
          surface: '#FFFFFF',
          input: '#F0EDE8',
          border: '#D4D0C8',
          text: '#1A1A1A',
          textSecondary: '#4A4A4A',
          textMuted: '#6B6B6B',
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
