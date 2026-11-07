// "amber" is re-coloured to the IPL orange so every existing accent in the app picks up the new look.
module.exports = {
  content: ['./app/**/*.{js,jsx}'],
  theme: { extend: {
    colors: {
      amber: { 50: '#fff4e8', 100: '#ffe4c7', 200: '#ffcb99', 300: '#ffb066', 400: '#ff8a1f', 500: '#f27300', 600: '#cc5f00', 700: '#a14b00' },
      ipl: { navy: '#070d24', deep: '#0a1230', blue: '#1b4bd6', sky: '#3b82f6' },
    },
    fontFamily: { display: ['var(--font-display)', 'Impact', 'Arial Narrow', 'sans-serif'] },
  } },
  plugins: [],
};
