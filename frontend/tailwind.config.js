/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        background: '#09090B', // Professional deep zinc
        surface: '#18181B', // Sleek surface zinc
        primary: {
          DEFAULT: '#2563EB', // Enterprise Blue
          foreground: '#FFFFFF',
        },
        secondary: {
          DEFAULT: '#4F46E5', // Indigo
          foreground: '#FFFFFF',
        },
        accent: {
          DEFAULT: '#38BDF8', // Light blue
          foreground: '#FFFFFF',
        },
        'text-primary': '#FAFAFA',
        'text-secondary': '#A1A1AA',
        border: '#27272A',
        input: '#18181B',
        ring: '#2563EB',
        foreground: '#FAFAFA',
        muted: {
          DEFAULT: '#27272A',
          foreground: '#A1A1AA',
        },
        card: {
          DEFAULT: '#18181B',
          foreground: '#FAFAFA',
        },
        popover: {
          DEFAULT: '#09090B',
          foreground: '#FAFAFA',
        },
      },
      borderRadius: {
        lg: '1rem',
        md: '0.75rem',
        sm: '0.5rem',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-up': { '0%': { transform: 'translateY(10px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        'glow': {
          '0%, 100%': { boxShadow: '0 0 15px rgba(139, 92, 246, 0.3)' },
          '50%': { boxShadow: '0 0 30px rgba(139, 92, 246, 0.6)' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-15px)' },
        },
        'ai-pulse': {
          '0%, 100%': { transform: 'scale(1)', opacity: '1', boxShadow: '0 0 0 0 rgba(6, 182, 212, 0.4)' },
          '50%': { transform: 'scale(1.05)', opacity: '0.8', boxShadow: '0 0 20px 10px rgba(6, 182, 212, 0.1)' },
        },
        'typing': {
          '0%': { width: '0' },
          '100%': { width: '100%' },
        },
        'blink': {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        }
      },
      animation: {
        'fade-in': 'fade-in 0.5s ease-out forwards',
        'slide-up': 'slide-up 0.5s ease-out forwards',
        'glow': 'glow 3s ease-in-out infinite',
        'float': 'float 4s ease-in-out infinite',
        'ai-pulse': 'ai-pulse 3s ease-in-out infinite',
        'typing': 'typing 2s steps(40, end)',
        'blink': 'blink 1s step-end infinite',
      },
      fontFamily: {
        'sans': ['Inter', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'glass-gradient': 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.01) 100%)',
        'glass-gradient-hover': 'linear-gradient(135deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 100%)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}