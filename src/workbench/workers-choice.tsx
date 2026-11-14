'use client';

/**
 * The Workers section of the New chat dialog: whether the chat hands its work
 * to worker chats, and on which agent and account those run
 * (docs/designs/orchestrator-workers.md). Drawn with the dialog's own pieces,
 * so it reads as one more question like Agent and Account.
 */

import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import type { Brand, ProfileChoice, WorkersChoice } from '@/workbench/protocol';
import { providerIsAvailable, type ProviderAvailability } from '@/workbench/providers';
import { SectionHeading } from '@/workbench/section-heading';

/** The agents a worker can run on: the ones with accounts to choose from. */
const WORKER_BRANDS: readonly Brand[] = ['claude', 'codex'];

export function WorkersChoicePicker({
  choice,
  onChange,
  providers,
  accounts,
  starred,
  chatBrand,
}: {
  choice: WorkersChoice | null;
  onChange: (choice: WorkersChoice | null) => void;
  providers: ProviderAvailability[];
  accounts: Partial<Record<Brand, ProfileChoice[]>>;
  /** The starred account per agent, which a worker starts on until another is picked. */
  starred: Partial<Record<Brand, string>>;
  /** The agent the chat itself runs on; workers default to the other one. */
  chatBrand: Brand;
}) {
  const brands = WORKER_BRANDS.filter((brand) => providerIsAvailable(providers, brand));
  const account = (brand: Brand) => {
    const listed = accounts[brand] ?? [];
    return listed.some((profile) => profile.id === starred[brand]) ? starred[brand]! : 'system';
  };
  const turnOn = (on: boolean) => {
    if (!on) return onChange(null);
    const brand = brands.find((one) => one !== chatBrand) ?? brands[0] ?? 'codex';
    onChange({ brand, profileId: account(brand) });
  };
  const workerAccounts = choice ? accounts[choice.brand] ?? [] : [];
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="new-chat-workers">
      <div className="flex items-center justify-between gap-3">
        <SectionHeading>Workers</SectionHeading>
        <Switch
          aria-label="Use workers"
          checked={choice !== null}
          onCheckedChange={turnOn}
          disabled={brands.length === 0}
          data-testid="new-chat-workers-switch"
        />
      </div>
      {choice && (
        <div role="group" aria-label="Workers" className="flex min-w-0 flex-col gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="md"
            className="grid grid-cols-2 gap-2"
            aria-label="Worker agent"
            value={choice.brand}
            onValueChange={(brand) => brand && onChange({ brand: brand as Brand, profileId: account(brand as Brand) })}
          >
            {brands.map((brand) => (
              <ToggleGroupItem key={brand} value={brand} aria-label={brandName(brand)} className="min-w-0" data-testid={`new-chat-worker-provider-${brand}`}>
                <BrandIcon brand={brand} /> {brandName(brand)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {workerAccounts.length > 1 && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="md"
              className="grid grid-cols-2 gap-2"
              aria-label="Worker account"
              value={choice.profileId ?? 'system'}
              onValueChange={(id) => id && onChange({ ...choice, profileId: id })}
            >
              {workerAccounts.map((profile) => (
                <ToggleGroupItem
                  key={profile.id}
                  value={profile.id}
                  className="min-w-0 justify-start"
                  data-testid={`new-chat-worker-profile-${profile.id}`}
                >
                  <span className="truncate">{profile.name}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </div>
      )}
    </div>
  );
}
