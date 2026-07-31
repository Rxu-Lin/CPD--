import { useEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { Color, Mesh, Program, Renderer, Triangle } from 'ogl'
import './SpecularButton.css'

const PAD = 20

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;

out vec4 fragColor;

float sdRoundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float gaussianLine(float d, float sigma) {
  float x = d / (sigma + 1e-6);
  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));
  return exp(-k * x * x);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = sdRoundedRect(p, uHalfSize, uRadius);
  vec2 lightDirection = vec2(cos(uAngle), sin(uAngle));
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;
  vec2 normal = normalize(p / (uHalfSize * uHalfSize) + 1e-6);
  float phi = acos(clamp(abs(dot(normal, lightDirection)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);
  float line = gaussianLine(d, uThickness);
  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));
  float highlight = line * rim * edgeClamp * uIntensity;
  vec3 color = uBaseColor * base + uLineColor * highlight;
  float alpha = clamp(base + highlight, 0.0, 1.0);
  fragColor = vec4(color, alpha);
}
`

type SpecularButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  radius?: number
  tint?: string
  tintOpacity?: number
  blur?: number
  textColor?: string
  lineColor?: string
  baseColor?: string
  intensity?: number
  shineSize?: number
  shineFade?: number
  thickness?: number
  speed?: number
  followMouse?: boolean
  proximity?: number
  autoAnimate?: boolean
}

type SpecularRuntimeProps = Pick<
  SpecularButtonProps,
  | 'radius'
  | 'lineColor'
  | 'baseColor'
  | 'intensity'
  | 'shineSize'
  | 'shineFade'
  | 'thickness'
  | 'speed'
  | 'followMouse'
  | 'proximity'
  | 'autoAnimate'
>

function SpecularButton({
  children = 'Get Started',
  size = 'lg',
  radius = 18,
  tint = '#ffffff',
  tintOpacity = 0,
  blur = 0,
  textColor = '#f5f5f5',
  lineColor = '#ffffff',
  baseColor = '#525252',
  intensity = 1,
  shineSize = 10,
  shineFade = 40,
  thickness = 1,
  speed = 0.35,
  followMouse = true,
  proximity = 250,
  autoAnimate = false,
  disabled = false,
  className = '',
  style,
  type = 'button',
  ...buttonProps
}: SpecularButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const effectRef = useRef<HTMLSpanElement>(null)
  const propsRef = useRef<SpecularRuntimeProps>({})

  propsRef.current = {
    radius,
    lineColor,
    baseColor,
    intensity,
    shineSize,
    shineFade,
    thickness,
    speed,
    followMouse,
    proximity,
    autoAnimate,
  }

  useEffect(() => {
    const button = buttonRef.current
    const effect = effectRef.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!button || !effect || reducedMotion.matches) return

    const dpr = window.devicePixelRatio || 1
    const renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: true, dpr })
    const gl = renderer.gl
    gl.clearColor(0, 0, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const geometry = new Triangle(gl)
    if (geometry.attributes.uv) delete geometry.attributes.uv

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uCenter: { value: [0, 0] },
        uHalfSize: { value: [1, 1] },
        uRadius: { value: 0 },
        uAngle: { value: 2.4 },
        uPx: { value: dpr },
        uLineColor: { value: [1, 1, 1] },
        uBaseColor: { value: [0.32, 0.32, 0.32] },
        uIntensity: { value: 1 },
        uShineSize: { value: 0.17 },
        uShineFade: { value: 0.7 },
        uThickness: { value: 1 },
        uBaseWidth: { value: dpr },
      },
    })

    const mesh = new Mesh(gl, { geometry, program })
    effect.appendChild(gl.canvas)

    const measuredSize = { width: 1, height: 1 }
    const resize = () => {
      const rect = button.getBoundingClientRect()
      measuredSize.width = rect.width
      measuredSize.height = rect.height
      renderer.setSize(rect.width + PAD * 2, rect.height + PAD * 2)
      program.uniforms.uCenter.value = [(PAD + rect.width / 2) * dpr, (PAD + rect.height / 2) * dpr]
      program.uniforms.uHalfSize.value = [(rect.width / 2) * dpr, (rect.height / 2) * dpr]
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(button)
    resize()

    let pointerAngle: number | null = null
    let proximityAmount = 0
    const handlePointerMove = (event: PointerEvent) => {
      const rect = button.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const distanceX = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right)
      const distanceY = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom)
      const distance = Math.hypot(distanceX, distanceY)

      if (distance === 0) {
        const normalizedX = (event.clientX - centerX) / (rect.width / 2)
        const normalizedY = (centerY - event.clientY) / (rect.height / 2)
        pointerAngle = Math.atan2(2 / rect.height, -2 / rect.width) + normalizedX * 0.3 + normalizedY * 0.15
      } else {
        pointerAngle = Math.atan2(centerY - event.clientY, event.clientX - centerX)
      }

      const amount = Math.max(0, 1 - distance / Math.max(propsRef.current.proximity ?? 1, 1))
      proximityAmount = amount * amount * (3 - 2 * amount)
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: true })

    let angle = 2.4
    let idleAngle = 2.4
    let brightness = 0
    let lastFrame = performance.now()
    let animationFrame = 0
    const line = new Color()
    const base = new Color()

    const update = (now: number) => {
      animationFrame = requestAnimationFrame(update)
      const delta = Math.min((now - lastFrame) / 1000, 0.05)
      lastFrame = now
      const current = propsRef.current
      idleAngle += (current.speed ?? 0.35) * delta
      const shouldFollow = current.followMouse && pointerAngle !== null && (!current.autoAnimate || proximityAmount > 0)
      const targetAngle = shouldFollow ? (pointerAngle ?? idleAngle) : idleAngle
      const difference = ((targetAngle - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
      angle += difference * (1 - Math.exp(-delta * 7))

      const targetBrightness = current.autoAnimate ? 1 : proximityAmount
      brightness += (targetBrightness - brightness) * (1 - Math.exp(-delta * 8))

      line.set(current.lineColor ?? '#ffffff')
      base.set(current.baseColor ?? '#525252')
      program.uniforms.uAngle.value = angle
      program.uniforms.uRadius.value =
        Math.min(current.radius ?? 18, Math.min(measuredSize.width, measuredSize.height) / 2) * dpr
      program.uniforms.uLineColor.value = [line.r, line.g, line.b]
      program.uniforms.uBaseColor.value = [base.r, base.g, base.b]
      program.uniforms.uIntensity.value = (current.intensity ?? 1) * brightness
      program.uniforms.uShineSize.value = ((current.shineSize ?? 10) * Math.PI) / 180
      program.uniforms.uShineFade.value = ((current.shineFade ?? 40) * Math.PI) / 180
      program.uniforms.uThickness.value = (current.thickness ?? 1) * dpr
      renderer.render({ scene: mesh })
    }
    animationFrame = requestAnimationFrame(update)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', handlePointerMove)
      if (gl.canvas.parentNode === effect) effect.removeChild(gl.canvas)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  const customStyle = {
    ...style,
    '--sb-radius': `${radius}px`,
    '--sb-tint': tint,
    '--sb-tint-opacity': tintOpacity,
    '--sb-blur': `${blur}px`,
    '--sb-text-color': textColor,
  } as CSSProperties

  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      type={type}
      disabled={disabled}
      className={`specular-button specular-button--${size}${className ? ` ${className}` : ''}`}
      style={customStyle}
    >
      <span ref={effectRef} className="specular-button__fx" aria-hidden="true" />
      <span className="specular-button__label">{children}</span>
    </button>
  )
}

export default SpecularButton
