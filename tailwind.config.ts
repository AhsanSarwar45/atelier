import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  // The whole of src, not the three folders that used to hold every class.
  // A class only reaches the stylesheet if Tailwind read the file spelling it,
  // so a colour moved out of a component — as the state colours were, into
  // `src/lib/state-styles.ts` — silently stops being built. Held by
  // `src/lib/__tests__/state-colours-build.test.ts` (corsetta cor-oio5).
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },

        // Surface: layered backgrounds
        surface: {
          base: 'hsl(var(--surface-base))',
          raised: 'hsl(var(--surface-raised))',
          overlay: 'hsl(var(--surface-overlay))',
          inset: 'hsl(var(--surface-inset))',
        },

        // Text hierarchy (use with text-t-*, bg-t-* etc.)
        t: {
          primary: 'hsl(var(--text-primary))',
          secondary: 'hsl(var(--text-secondary))',
          tertiary: 'hsl(var(--text-tertiary))',
          muted: 'hsl(var(--text-muted))',
          faint: 'hsl(var(--text-faint))',
        },

        // Border hierarchy
        b: {
          default: 'hsl(var(--border-default))',
          subtle: 'hsl(var(--border-subtle))',
          strong: 'hsl(var(--border-strong))',
        },

        // Status: kanban column colors
        status: {
          open: 'hsl(var(--status-open))',
          progress: 'hsl(var(--status-progress))',
          review: 'hsl(var(--status-review))',
          manager: 'hsl(var(--status-manager))',
          closed: 'hsl(var(--status-closed))',
          cancelled: 'hsl(var(--status-cancelled))',
        },

        // Semantic feedback
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        danger: 'hsl(var(--danger))',
        info: 'hsl(var(--info))',

        // Feature-specific
        epic: 'hsl(var(--epic))',
        'blocked-accent': 'hsl(var(--blocked-accent))',

        // Priority colors
        priority: {
          p0: 'hsl(var(--priority-p0))',
          p1: 'hsl(var(--priority-p1))',
          p2: 'hsl(var(--priority-p2))',
          p3: 'hsl(var(--priority-p3))',
          p4: 'hsl(var(--priority-p4))',
        },

        // Progress bar
        progress: {
          100: 'hsl(var(--progress-100))',
          75: 'hsl(var(--progress-75))',
          50: 'hsl(var(--progress-50))',
          25: 'hsl(var(--progress-25))',
          0: 'hsl(var(--progress-0))',
        },

        // Activity events
        event: {
          created: 'hsl(var(--event-created))',
          status: 'hsl(var(--event-status))',
          comment: 'hsl(var(--event-comment))',
          branch: 'hsl(var(--event-branch))',
          child: 'hsl(var(--event-child))',
        },

        // File diff
        diff: {
          added: 'hsl(var(--diff-added))',
          removed: 'hsl(var(--diff-removed))',
          renamed: 'hsl(var(--diff-renamed))',
        },

        // Legacy (kept for compatibility)
        blocked: 'hsl(var(--blocked))',
        branch: 'hsl(var(--branch))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    require('@tailwindcss/typography'),
  ],
};

export default config;
