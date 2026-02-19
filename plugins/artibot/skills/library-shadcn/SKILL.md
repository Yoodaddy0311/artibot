---
name: library-shadcn
description: "shadcn/ui component patterns for React including installation, theming, composition, and accessibility."
level: 2
triggers: ["shadcn", "shadcn/ui", "radix", "tailwind components", "ui library", "component library", "dark mode"]
agents: ["frontend-developer", "architect"]
tokens: "~4K"
category: "library"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# shadcn/ui Component Patterns

## When This Skill Applies
- Building React UIs with shadcn/ui components
- Setting up theming and dark mode support
- Composing complex UI patterns from primitive components
- Customizing component variants with Tailwind CSS
- Ensuring accessibility compliance in component usage
- Integrating shadcn/ui with Next.js, Remix, or Vite projects

## Core Guidance

### 1. Installation & Setup

**Initialize in a project**:
```bash
npx shadcn@latest init
```

**Add individual components** (not installed as dependency -- copied into your project):
```bash
npx shadcn@latest add button
npx shadcn@latest add dialog
npx shadcn@latest add form
```

**Key Principle**: shadcn/ui copies component source code into your project. You own the code and can customize freely. This is not a traditional npm package.

**Project Structure**:
```
src/
  components/
    ui/           # shadcn/ui primitives (auto-generated)
      button.tsx
      dialog.tsx
      input.tsx
    custom/       # Your compositions using ui primitives
      user-form.tsx
      data-table.tsx
  lib/
    utils.ts      # cn() utility for class merging
```

### 2. Theming System

**CSS Variables** (defined in `globals.css`):
```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --border: 214.3 31.8% 91.4%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
  }
}
```

**Theme Customization Rules**:
- Modify CSS variables, not component source (when possible)
- Use HSL format without the `hsl()` wrapper for variable values
- All shadcn components reference these variables via Tailwind classes
- Generate custom themes at ui.shadcn.com/themes

### 3. Dark Mode Implementation

**Next.js with next-themes**:
```tsx
// app/layout.tsx
import { ThemeProvider } from 'next-themes'

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
```

**Theme Toggle Component**:
```tsx
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  const { setTheme, theme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
    >
      <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  )
}
```

### 4. Component Composition Patterns

**Form with Validation** (React Hook Form + Zod):
```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(50),
})

export function UserForm() {
  const form = useForm({ resolver: zodResolver(schema) })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="user@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Submit</Button>
      </form>
    </Form>
  )
}
```

**Data Table Pattern**:
```tsx
import { DataTable } from '@/components/ui/data-table'
import { columns } from './columns'

// columns.tsx defines column config with @tanstack/react-table
// DataTable wraps Table, TableHeader, TableBody, TableRow, TableCell
```

**Dialog with Form**:
```tsx
<Dialog>
  <DialogTrigger asChild>
    <Button>Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Edit Profile</DialogTitle>
      <DialogDescription>Update your information below.</DialogDescription>
    </DialogHeader>
    <UserForm />
  </DialogContent>
</Dialog>
```

### 5. Component Variants with CVA

**Class Variance Authority** (used internally by shadcn):
```tsx
import { cva, type VariantProps } from 'class-variance-authority'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)
```

**Extending Components**:
```tsx
// Add custom variants by modifying the copied component source
// Or compose with wrapper components for project-specific patterns
```

### 6. Tailwind CSS Integration

**The `cn()` Utility** (essential for class merging):
```tsx
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Usage: cn('px-4 py-2', isActive && 'bg-primary', className)
```

**Responsive Design**:
```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  <Card className="col-span-1 md:col-span-2 lg:col-span-1">
    {/* Content */}
  </Card>
</div>
```

### 7. Accessibility Guidelines

**Built-in Accessibility** (via Radix UI primitives):
- Keyboard navigation (Tab, Enter, Escape, Arrow keys)
- Focus management and focus trapping in modals
- ARIA attributes automatically applied
- Screen reader announcements for dynamic content

**Your Responsibilities**:
- Always provide `DialogTitle` and `DialogDescription` for dialogs
- Use `sr-only` class for icon-only buttons: `<span className="sr-only">Close</span>`
- Set `aria-label` on interactive elements without visible text
- Maintain color contrast ratios (4.5:1 for normal text, 3:1 for large text)
- Test with keyboard navigation (no mouse)
- Verify with screen reader (VoiceOver, NVDA)

**Focus Management**:
```tsx
// Dialog auto-focuses first focusable element
// Sheet auto-manages focus trap
// Popover returns focus to trigger on close
// Use autoFocus={false} to override default focus behavior
```

### 8. Common Component Patterns

| Pattern | Components Used | Use Case |
|---------|----------------|----------|
| CRUD Table | DataTable + Dialog + Form | Admin panels, data management |
| Command Palette | Command + CommandInput + CommandList | Search, navigation |
| Settings Page | Tabs + Form + Switch + Select | User preferences |
| Dashboard | Card + Chart + Table + Badge | Analytics, overview |
| Auth Pages | Card + Form + Input + Button | Login, signup |
| Navigation | NavigationMenu + Sheet (mobile) | Site header, sidebar |

## Anti-Patterns

- Installing shadcn/ui as an npm package (it copies source files, not a dependency)
- Overriding component styles with `!important` instead of modifying source
- Not using the `cn()` utility for conditional classes
- Forgetting `asChild` prop when wrapping triggers with custom elements
- Missing `DialogTitle` causing accessibility warnings
- Hardcoding colors instead of using CSS variable tokens

## Quick Reference

**Add Component**: `npx shadcn@latest add [component-name]`
**Class Merging**: Always use `cn()` for conditional and merged classes
**Theming**: Modify CSS variables in `globals.css`, not component source
**Dark Mode**: `next-themes` + `attribute="class"` + `.dark` CSS scope
**Forms**: React Hook Form + Zod + shadcn Form components
**Accessibility**: Radix handles ARIA; you handle labels, contrast, and keyboard testing
