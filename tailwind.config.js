/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#06101d',
        panel: '#0c1d33',
        accent: '#4fe5e8',
        mint: '#6de0b8',
      },
      boxShadow: {
        glow: '0 0 28px rgba(79, 229, 232, 0.35)',
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(79, 229, 232, 0.45)' },
          '70%': { boxShadow: '0 0 0 12px rgba(79, 229, 232, 0)' },
        },
      },
      animation: {
        'pulse-soft': 'pulseSoft 2s infinite',
      },
    },
  },
  plugins: [],
};
