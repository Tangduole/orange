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
          bg: '#F5F5F5',
          surface: '#FFFFFF',
          input: '#EEEEEE',
          border: '#E0E0E0',
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
