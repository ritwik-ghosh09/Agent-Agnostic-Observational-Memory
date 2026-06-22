import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme, type Theme } from '@/lib/theme'

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'grey', label: 'Grey', Icon: Monitor },
]

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5 ml-auto">
      {THEMES.map(({ value, label, Icon }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          title={`${label} theme`}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
            theme === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Icon className="h-3 w-3" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
