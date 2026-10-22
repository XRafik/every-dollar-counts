// Shared class strings for consistent form controls across the app.
//
// `min-h-[44px] md:min-h-0`: §7 asks for a 44px minimum tap height on a phone, and every control
// here was under it — this one was ≈38px, the select ≈34px. Released at `md` so the desktop
// layouts stages 1-4 shipped are untouched; the padding below still sets the height there.

export const inputClass =
  'w-full min-h-[44px] md:min-h-0 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40'

export const selectClass =
  'w-full md:w-auto min-h-[44px] md:min-h-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:opacity-50'

export const labelClass = 'text-sm font-medium text-ink'

// A control that is only its text: a text link, or a text button such as "Show all". Below `md` its
// hit area grows to §7's 44px and the text stays the size it is, the way ReimbursableCheckbox's
// label and ReimbursableEditor's ⋮ grow theirs; `items-center` keeps the text centred in the taller
// box. Each of these was 16-20px tall on a phone (#122). Released at `md`, where the text sets the
// height as it always has. A link inside a sentence makes its line 44px tall on a phone.
export const tapTargetClass = 'inline-flex min-h-[44px] min-w-[44px] items-center md:min-h-0 md:min-w-0'
