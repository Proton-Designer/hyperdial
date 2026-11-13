"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "./utils";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/* Touch screens have no hover, so Radix never opens a tooltip there. On a coarse pointer a tap on the
   trigger opens it for a couple of seconds (tap elsewhere or wait to dismiss). Desktop is unchanged. */
const TapTooltipContext = React.createContext<((open: boolean) => void) | null>(
  null,
);

function Tooltip({
  open: openProp,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [tapOpen, setTapOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const open = openProp ?? tapOpen;
  const setOpen = (next: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    if (next) timer.current = setTimeout(() => setTapOpen(false), 2500);
    setTapOpen(next);
    onOpenChange?.(next);
  };
  return (
    <TooltipProvider>
      <TapTooltipContext.Provider value={setOpen}>
        <TooltipPrimitive.Root
          data-slot="tooltip"
          open={open}
          onOpenChange={(next) => {
            setTapOpen(next);
            onOpenChange?.(next);
          }}
          {...props}
        />
      </TapTooltipContext.Provider>
    </TooltipProvider>
  );
}

function TooltipTrigger({
  onClick,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const setOpen = React.useContext(TapTooltipContext);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onClick={(e) => {
        onClick?.(e);
        if (
          setOpen &&
          typeof window !== "undefined" &&
          window.matchMedia("(pointer: coarse)").matches
        ) {
          setOpen(true);
        }
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
