/**
 * A number chosen by sliding.
 *
 * The app has exactly one of these — the reader's text size — and it was drawn
 * on the settings screen itself, which is the one place paint may not live. The
 * track and the thumb are the browser's, tinted with the theme's own strongest
 * text colour; the coarse-pointer floor in globals.css is what makes it big
 * enough for a thumb on a phone (bw-dks8.8).
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

const Slider = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<'input'>, 'type'>>(
  function Slider({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="range"
        data-slot="slider"
        className={cn('h-2 flex-1 accent-t-primary', className)}
        {...props}
      />
    );
  },
);

export { Slider };
