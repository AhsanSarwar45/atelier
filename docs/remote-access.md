# Reaching the board from outside your network

The board answers everyone on your own network already, and
[the README says how to open it on a phone](../README.md#open-it-on-your-phone).
This is the other question: reaching it from a café, from a train, from
anywhere that is not your house.

## Read this part first

**Atelier has no password.** There is no sign-in, no session, no token, no
account. Whoever can reach the port is the owner of this computer as far as the
program is concerned. That is a deliberate shape for something answering your
own network, and it is the whole of the danger the moment the port is not on
your own network.

What a caller who reaches it can do, with no credential of any kind:

- Read and write any file under your home folder — `/api/fs/write`,
  `/api/fs/delete`, `/api/fs/rename` (`server/src/routes/fs.rs`). Your keys,
  your shell startup files, everything.
- Start and prompt Claude or Codex under your own signed-in accounts, and read
  every chat you have ever had — `/api/workbench/*`.
- Commit, push and pull with your own git credentials — `/api/git/*`.
- Repoint the path this program uses for `git`, `bd`, `claude` or `codex` at
  any binary on the machine — `/api/environment/:tool`. That one is arbitrary
  code execution wearing a settings screen.

A shell is the one thing held back: `/api/terminal` is guarded by a host
allowlist (`server/src/local_host.rs`), and that guard is laid over the
terminal routes and nothing else. Everything in the list above is open.

So the rule this document exists to state:

> **Never forward port 3008 from your router.** Not with a certificate, not
> with a strange port number, not for five minutes. There is no authentication
> behind it, and a port that answers the internet is found in hours.

What follows keeps the port off the internet entirely.

## The arrangement: a private network, not a published one

[Tailscale](https://tailscale.com) builds a private network out of the devices
you sign in — your computer, your phone, nothing else. Your phone reaches the
board because it is on that network, not because the board is reachable.

It also solves a second problem for free. A phone will not give a page
notification powers over plain `http`: `navigator.serviceWorker` and
`window.Notification` do not exist on an insecure origin, which is why
notifications on a phone have never worked from `http://nobara.local:3008`.
Tailscale issues a real Let's Encrypt certificate for a
`machine.tailnet.ts.net` name, so the page loads over `https` with nothing to
install on the phone and no warning screen to click past.

### Setting it up

Tailscale is packaged for this machine, so installing it is:

```bash
sudo dnf install tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
```

`tailscale up` prints a link; open it and sign in. Install the Tailscale app on
your phone and sign into the same account.

Then, once, in the Tailscale admin console under **DNS**: enable **MagicDNS**,
then enable **HTTPS Certificates**. It will ask you to acknowledge that machine
names are published on a public certificate transparency ledger — that is a
real consequence and the next section says what it means.

Now put the board behind it:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3008
tailscale serve status
```

`serve` is the tailnet-only one. Its sibling `tailscale funnel` publishes to the
whole internet — **do not use funnel with this program**, for every reason in
the first section.

### Close the door behind it

With Tailscale carrying the traffic, the program itself no longer needs to
answer the network:

```bash
ATELIER_HOST=127.0.0.1 ATELIER_PUBLIC_URL=nobara.tailnet-name.ts.net atelier run
```

`ATELIER_HOST=127.0.0.1` means the only thing that can reach the port is
something on this computer — which is now Tailscale and nothing else. Even a
laptop on the same café Wi-Fi as you finds a closed port.

`ATELIER_PUBLIC_URL` tells the program the name on the certificate in front of
it. It cannot find that out for itself: the name belongs to Tailscale, not to
this computer. Told it, the banner names the address you should actually open:

```
Atelier is running.
  On this computer   http://localhost:3008
  Network            https://nobara.tailnet-name.ts.net
```

Without it, the banner would go on offering a plain `http` address on a machine
that has stopped answering it — three ways of being wrong at once. A bare name
is read as `https://`; write the scheme yourself if you mean something else.

Substitute your own tailnet name, which `tailscale serve status` prints.

## What it costs

**Your machine's name becomes public.** Enabling HTTPS certificates publishes
`nobara.your-tailnet.ts.net` to the certificate transparency ledger, which
anyone can read. The name is public; nothing behind it is reachable without
being on your tailnet. Rename the machine first if its current name says
something you would not put on a postcard.

**The phone needs the Tailscale app running.** It is always-on and quiet, but
it is a thing that can be off, and when it is off the board is not there.

**Certificates last 90 days.** `tailscale serve` renews its own. A certificate
you fetched by hand with `tailscale cert` does not renew itself.

**On your own Wi-Fi it stays fast.** Tailscale connects your phone and this
computer directly over your own network whenever it can, so the traffic does
not leave the house and the speed is the speed you have now. It falls back to
relaying through a Tailscale server only when a network blocks the direct path
— some guest and corporate Wi-Fi does. If the board feels slow on your own
network, `tailscale status` says `direct` or `relay` for each device, and that
is the thing to look at.

## The alternative, and why it is second

A Cloudflare Tunnel with Cloudflare Access in front of it reaches the board from
a device with nothing installed, which is the one thing Tailscale cannot do.
The costs are real, though: every request travels to a Cloudflare data centre
and back even when the phone is in the same room, so it is slower on your own
network than doing nothing at all; Cloudflare terminates the TLS, so your files
and chat transcripts are readable at their edge; and Access is the only thing
between the internet and an unauthenticated shell, so a misconfiguration there
is the whole machine.

If you go that way, `ATELIER_HOST=127.0.0.1` and `ATELIER_PUBLIC_URL` work
exactly the same — the program does not care what is in front of it, only what
the address is called.

## Where this is checked

The banner rules live in `server/src/reachable.rs` and are tested without a
socket in the same file: an address in front takes the network line and plain
ones fall behind it; loopback-only stops being reported as local-only when
something in front is named; a name written alone is read as `https://`.
