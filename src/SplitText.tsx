import { useEffect, useRef, useState, type CSSProperties, type ElementType } from 'react'
import { gsap } from 'gsap'
import { SplitText as GSAPSplitText } from 'gsap/SplitText'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(GSAPSplitText, useGSAP)

type SplitTextProps = {
  text: string
  className?: string
  delay?: number
  duration?: number
  ease?: string
  splitType?: 'chars' | 'words' | 'lines' | 'words, chars'
  from?: gsap.TweenVars
  to?: gsap.TweenVars
  textAlign?: CSSProperties['textAlign']
  tag?: ElementType
  onLetterAnimationComplete?: () => void
}

export default function SplitText({
  text,
  className = '',
  delay = 50,
  duration = 1.25,
  ease = 'power3.out',
  splitType = 'chars',
  from = { opacity: 0, y: 40 },
  to = { opacity: 1, y: 0 },
  textAlign = 'center',
  tag: Tag = 'p',
  onLetterAnimationComplete,
}: SplitTextProps) {
  const ref = useRef<HTMLElement | null>(null)
  const animationCompletedRef = useRef(false)
  const onCompleteRef = useRef(onLetterAnimationComplete)
  const [fontsLoaded, setFontsLoaded] = useState(false)

  useEffect(() => {
    onCompleteRef.current = onLetterAnimationComplete
  }, [onLetterAnimationComplete])

  useEffect(() => {
    let active = true
    if (document.fonts.status === 'loaded') {
      setFontsLoaded(true)
      return () => {
        active = false
      }
    }

    void document.fonts.ready.then(() => {
      if (active) setFontsLoaded(true)
    })

    return () => {
      active = false
    }
  }, [])

  useGSAP(
    () => {
      if (!ref.current || !text || !fontsLoaded || animationCompletedRef.current) return

      const element = ref.current
      const split = new GSAPSplitText(element, {
        type: splitType,
        smartWrap: true,
        linesClass: 'split-line',
        wordsClass: 'split-word',
        charsClass: 'split-char',
        reduceWhiteSpace: false,
      })
      const targets = splitType.includes('chars')
        ? split.chars
        : splitType.includes('words')
          ? split.words
          : split.lines
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

      if (prefersReducedMotion) {
        gsap.set(targets, to)
        animationCompletedRef.current = true
        onCompleteRef.current?.()
        return () => split.revert()
      }

      const tween = gsap.fromTo(targets, from, {
        ...to,
        duration,
        ease,
        stagger: delay / 1000,
        force3D: true,
        willChange: 'transform, opacity, filter',
        onComplete: () => {
          animationCompletedRef.current = true
          onCompleteRef.current?.()
        },
      })

      return () => {
        tween.kill()
        split.revert()
      }
    },
    {
      dependencies: [
        text,
        delay,
        duration,
        ease,
        splitType,
        JSON.stringify(from),
        JSON.stringify(to),
        fontsLoaded,
      ],
      scope: ref,
    },
  )

  return (
    <Tag
      ref={ref}
      className={`split-parent ${className}`.trim()}
      style={{
        display: 'inline-block',
        margin: 0,
        overflow: 'hidden',
        textAlign,
        whiteSpace: 'normal',
        overflowWrap: 'break-word',
        willChange: 'transform, opacity',
      }}
    >
      {text}
    </Tag>
  )
}
