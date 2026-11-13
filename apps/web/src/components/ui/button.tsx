import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background text-foreground hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
        /* FE-A button system (tokens/globals.css): primary/secondary/ghost/danger/warning. Kept
           alongside the shadcn defaults above -- existing call sites using default/destructive/
           outline/link are untouched; new and updated call sites use these named variants. Glow
           is reserved for the primary CTA's hover state only, per the token spec. */
        primary:
          "bg-gradient-to-r from-accent-from to-accent-to text-white shadow-app-sm hover:shadow-[0_6px_24px_rgba(0,217,255,0.35)] hover:-translate-y-px",
        "fe-secondary":
          "bg-surface-2 text-text-primary border border-border-subtle hover:bg-surface-3 hover:border-border-strong",
        "fe-ghost": "text-text-secondary hover:bg-white/5 hover:text-text-primary",
        danger: "bg-danger text-white hover:bg-danger/90",
        warning: "bg-warning text-[#1a1200] hover:bg-warning/90",
        /* FE-B additions: a tinted/soft fill for a secondary-weight action that still needs a
           status colour (Pause) without the "muddy solid fill" look a full `warning`/`danger`
           button has, and a ghost-weight destructive action (Stop/Hang up as a lower-emphasis
           control next to a primary action) that only tints on hover. */
        "warning-soft": "bg-warning-soft text-warning hover:bg-warning/20",
        "danger-ghost": "text-danger hover:bg-danger-soft",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3 max-md:min-h-11",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5 max-md:min-h-11",
        md: "h-9 px-4 py-2 has-[>svg]:px-3 max-md:min-h-11",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4 max-md:min-h-11",
        icon: "size-9 rounded-md max-md:min-h-11 max-md:min-w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a spinner in place of the leading icon and disables the button -- for an in-flight
     *  action (save/connect/delete), not a screen's first-load state (that's a Skeleton). */
    loading?: boolean;
  };

// FE-B: forwardRef, unlike this file's original plain-function-component shape -- the first real
// `asChild` usage inside a Radix trigger (a DropdownMenuTrigger wrapping a Button) hit "Function
// components cannot be given refs": Slot clones its child and attaches a ref so the Radix
// primitive it wraps can be measured/positioned, same underlying cause as ui/sheet.tsx's FE-A
// fix. Latent since Button was created; every plain (non-asChild) call site is unaffected.
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    // Slot (asChild) requires exactly one child element (React.Children.only) -- never inject the
    // spinner alongside children in that branch, only for a real <button>.
    const content =
      !asChild && loading ? (
        <>
          <Loader2 className="animate-spin" />
          {children}
        </>
      ) : (
        children
      );

    return (
      <Comp
        ref={ref}
        data-slot="button"
        aria-busy={loading || undefined}
        disabled={disabled || loading}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        {content}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
