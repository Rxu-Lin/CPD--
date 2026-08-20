import type { CSSProperties, InputHTMLAttributes } from 'react'
import './UnifiedRange.css'

type UnifiedRangeProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'min' | 'max' | 'value' | 'onChange'> & {
  min: number
  max: number
  value: number
  onValueChange: (value: number) => void
}

export default function UnifiedRange({ min, max, value, onValueChange, className = '', ...props }: UnifiedRangeProps) {
  const progress = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
  const style = { '--range-progress': `${progress}%` } as CSSProperties

  return (
    <span className={`unified-range ${className}`.trim()} style={style}>
      <span className="unified-range__track" aria-hidden="true">
        <span className="unified-range__progress" />
      </span>
      <input
        {...props}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onValueChange(Number(event.target.value))}
      />
    </span>
  )
}
