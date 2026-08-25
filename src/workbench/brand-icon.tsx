'use client';

import { Bot, SquareCode } from 'lucide-react';
import type { Brand } from '@/workbench/protocol';
import { cn } from '@/lib/utils';

export function brandName(brand: Brand): string {
  return brand === 'codex' ? 'Codex' : 'Claude';
}

/** A stable product-neutral mark; vendor artwork is deliberately not bundled. */
export function BrandIcon({ brand, className }: { brand: Brand; className?: string }) {
  const Icon = brand === 'codex' ? SquareCode : Bot;
  return <Icon className={cn('size-4 shrink-0', className)} aria-label={brandName(brand)} />;
}
