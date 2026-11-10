import { Slider as S } from 'radix-ui';

export function Slider({ value, onChange, min = 0, max = 1, step = 0.01, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string }) {
  return (
    <S.Root
      className="relative flex h-5 w-full touch-none select-none items-center"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
    >
      <S.Track className="relative h-[4px] grow overflow-hidden rounded-full bg-active">
        <S.Range className="absolute h-full rounded-full bg-human" />
      </S.Track>
      {/* The thumb is what a screen reader meets (role slider): the name goes on it. */}
      <S.Thumb
        aria-label={label}
        className="block size-[14px] rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,.15),0_1px_3px_rgba(0,0,0,.35)] outline-none transition-shadow focus-visible:shadow-[0_0_0_4px_var(--human-soft)]"
      />
    </S.Root>
  );
}
