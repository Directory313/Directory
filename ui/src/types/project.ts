// Mirror of crates/veyra-core/src/model.rs + anim.rs (serde camelCase). Keep in sync.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Color = [number, number, number, number];
export type Id = string;

export type Interp = 'linear' | 'hold' | 'bezier';
export interface Handle { x: number; y: number }
export interface Keyframe<T> { t: number; v: T; interp?: Interp; outH?: Handle; inH?: Handle }
export interface Prop<T> { value: T; keys?: Keyframe<T>[]; expr?: string | null }

export type ParamValue = boolean | number | number[] | string;

export interface PathVertex { p: Vec2; i: Vec2; o: Vec2 }
export interface BezPath { vertices: PathVertex[]; closed: boolean }

export type AssetKind = 'video' | 'audio' | 'image' | 'imageSequence' | 'svg' | 'model3d' | 'lut';

export interface MediaInfo {
  width: number; height: number; fps: number; duration: number;
  hasVideo: boolean; hasAudio: boolean; hasAlpha: boolean;
  videoCodec: string; pixFmt: string; audioCodec: string; sampleRate: number; channels: number;
  frameCount: number; variableFrameRate: boolean; rotation: number; colorSpace: string; bitRate: number; fileSize: number;
}

export interface Asset {
  id: Id; name: string; kind: AssetKind; path: string; relativePath?: string | null; info: MediaInfo;
  folder?: Id | null; tags: string[]; favorite: boolean; proxy?: string | null; useProxy: boolean;
  sequencePattern?: string | null; sequenceStart: number; missing: boolean; fingerprint: string;
}

export interface Folder { id: Id; name: string; parent?: Id | null }
export interface Marker { id: Id; t: number; label: string; color?: string | null }

export type ColorSpace = 'rec709' | 'srgb' | 'rec2020' | 'displayP3' | 'linear';
export interface MotionBlurSettings { shutterAngle: number; shutterPhase: number; samples: number }

export interface Composition {
  id: Id; name: string; width: number; height: number; fps: number; duration: number;
  background: Color; transparent: boolean; pixelAspect: number; sampleRate: number; channels: number;
  colorSpace: ColorSpace; layers: Layer[]; markers: Marker[]; workArea?: [number, number] | null;
  motionBlur: MotionBlurSettings;
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'softLight' | 'hardLight' | 'darken' | 'lighten'
  | 'difference' | 'exclusion' | 'add' | 'subtract' | 'color' | 'hue' | 'saturation' | 'luminosity';
export const BLEND_MODES: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'darken', 'lighten',
  'difference', 'exclusion', 'add', 'subtract', 'color', 'hue', 'saturation', 'luminosity'];

export type MatteMode = 'alpha' | 'alphaInverted' | 'luma' | 'lumaInverted';
export interface TrackMatte { layer: Id; mode: MatteMode }

export interface Transform { anchor: Prop<Vec3>; position: Prop<Vec3>; scale: Prop<Vec3>; rotation: Prop<Vec3>; opacity: Prop<number> }

export type MaskMode = 'add' | 'subtract' | 'intersect' | 'difference' | 'lighten' | 'darken' | 'none';
export interface Mask { id: Id; name: string; mode: MaskMode; inverted: boolean; path: Prop<BezPath>; feather: Prop<number>; expansion: Prop<number>; opacity: Prop<number>; enabled: boolean }

export interface Effect { id: Id; kind: string; enabled: boolean; name?: string | null; params: Record<string, Prop<ParamValue>> }

export type TransitionKind = 'crossDissolve' | 'dipToBlack' | 'dipToWhite' | 'wipeLeft' | 'wipeRight' | 'wipeUp' | 'wipeDown'
  | 'slideLeft' | 'slideRight' | 'zoomIn' | 'zoomOut' | 'blur' | 'spin';
export const TRANSITIONS: TransitionKind[] = ['crossDissolve', 'dipToBlack', 'dipToWhite', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'slideLeft', 'slideRight', 'zoomIn', 'zoomOut', 'blur', 'spin'];
export interface Transition { kind: TransitionKind; duration: number; ease: boolean }

export interface AudioProps { volume: Prop<number>; pan: Prop<number>; fadeIn: number; fadeOut: number; effects: Effect[] }

export interface Material {
  baseColor: Prop<Color>; metallic: Prop<number>; roughness: Prop<number>; specular: Prop<number>;
  emission: Prop<Color>; emissionStrength: Prop<number>; lit: boolean;
  baseTexture?: Id | null; normalTexture?: Id | null; roughnessTexture?: Id | null; metallicTexture?: Id | null;
  uvTiling: Vec2; uvOffset: Vec2; doubleSided: boolean;
}

export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';
export interface GradientStop { pos: number; color: Color }
export interface Gradient { radial: boolean; start: Vec2; end: Vec2; stops: GradientStop[] }
export type TextUnit = 'characters' | 'words' | 'lines';
export interface TextAnimator {
  id: Id; name: string; unit: TextUnit; start: Prop<number>; end: Prop<number>; offset: Prop<number>; smoothness: number;
  opacity: Prop<number>; position: Prop<Vec2>; scale: Prop<number>; rotation: Prop<number>; tracking: Prop<number>; fill?: Prop<Color> | null;
}
export interface TextProps {
  text: Prop<string>; fontFamily: string; fontWeight: number; italic: boolean; fontSize: Prop<number>; tracking: Prop<number>;
  lineHeight: Prop<number>; fill: Prop<Color>; gradient?: Gradient | null; stroke: Prop<Color>; strokeWidth: Prop<number>;
  align: Align; valign: VAlign; boxWidth: number; background?: { color: Prop<Color>; padding: number; radius: number } | null;
  animators: TextAnimator[]; onPath?: BezPath | null; extrude: number;
}

export type Geometry =
  | { type: 'rect'; size: Prop<Vec2>; roundness: Prop<number> }
  | { type: 'ellipse'; size: Prop<Vec2> }
  | { type: 'polygon'; points: Prop<number>; outerRadius: Prop<number>; innerRadius: Prop<number>; star: boolean; roundness: Prop<number> }
  | { type: 'line'; to: Prop<Vec2> }
  | { type: 'arrow'; to: Prop<Vec2>; head: Prop<number> }
  | { type: 'path'; path: Prop<BezPath> };
export interface Fill { color: Prop<Color>; gradient?: Gradient | null; opacity: Prop<number>; enabled: boolean }
export interface Stroke {
  color: Prop<Color>; gradient?: Gradient | null; width: Prop<number>; opacity: Prop<number>;
  cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' | 'bevel'; align: 'center' | 'inside' | 'outside';
  dashes: number[]; dashOffset: Prop<number>; enabled: boolean;
}
export interface Repeater { copies: Prop<number>; offset: Prop<Vec2>; rotation: Prop<number>; scale: Prop<number>; opacityEnd: Prop<number>; radial: boolean; radius: Prop<number> }
export interface TrimPaths { start: Prop<number>; end: Prop<number>; offset: Prop<number> }
export interface ShapeItem { id: Id; name: string; geometry: Geometry; offset: Prop<Vec2>; rotation: Prop<number>; fills: Fill[]; strokes: Stroke[]; repeater?: Repeater | null; trim?: TrimPaths | null }
export interface ShapeProps { items: ShapeItem[]; combine: 'none' | 'union' | 'subtract' | 'intersect' | 'exclude'; extrude: number }

export interface CameraProps {
  projection: 'perspective' | 'orthographic'; zoom: Prop<number>; pointOfInterest: Prop<Vec3>; usePointOfInterest: boolean;
  depthOfField: boolean; focusDistance: Prop<number>; aperture: Prop<number>; near: number; far: number;
}
export type LightKind = 'point' | 'directional' | 'spot' | 'area' | 'ambient' | 'environment';
export interface LightProps {
  light: LightKind; color: Prop<Color>; intensity: Prop<number>; range: Prop<number>; coneAngle: Prop<number>; coneFeather: Prop<number>;
  falloff: Prop<number>; castsShadows: boolean; shadowDarkness: Prop<number>; shadowResolution: number; size: Prop<number>;
}
export type MeshPrimitive =
  | { type: 'cube'; size: number }
  | { type: 'sphere'; radius: number; segments: number; rings: number }
  | { type: 'cylinder'; radius: number; height: number; segments: number }
  | { type: 'cone'; radius: number; height: number; segments: number }
  | { type: 'torus'; radius: number; tube: number; segments: number; sides: number }
  | { type: 'plane'; width: number; height: number; subdivisions: number }
  | { type: 'pyramid'; size: number; height: number }
  | { type: 'circle'; radius: number; segments: number }
  | { type: 'grid'; width: number; height: number; cells: number }
  | { type: 'imported'; asset: Id; node?: number | null }
  | { type: 'custom'; positions: Vec3[]; indices: number[] };
export interface MeshProps { primitive: MeshPrimitive; wireframe: boolean; smooth: boolean }

export interface ParticleProps {
  emitter: 'point' | 'line' | 'box' | 'circle'; emitterSize: Prop<Vec2>; rate: Prop<number>; maxParticles: number;
  lifetime: Prop<number>; lifetimeRandom: number; speed: Prop<number>; speedRandom: number; direction: Prop<number>; spread: Prop<number>;
  gravity: Prop<Vec2>; drag: number; turbulence: Prop<number>; turbulenceScale: number; size: Prop<number>; sizeRandom: number; sizeEnd: number;
  rotationSpeed: number; color: Prop<Color>; colorEnd: Color; opacity: Prop<number>; fadeOut: boolean; floor?: number | null; bounce: number;
  trail: number; seed: number; shape: 'circle' | 'square' | 'star' | 'spark';
}
export type GeneratorKind = 'grid' | 'noise' | 'wave' | 'gradient' | 'checkerboard' | 'animatedBackground';
export interface GeneratorProps { generator: GeneratorKind; params: Record<string, Prop<ParamValue>> }

export type LayerKind =
  | { type: 'media'; asset: Id }
  | { type: 'audio'; asset: Id }
  | { type: 'solid'; color: Prop<Color>; width: number; height: number }
  | ({ type: 'text' } & TextProps)
  | ({ type: 'shape' } & ShapeProps)
  | { type: 'null' }
  | { type: 'adjustment' }
  | { type: 'comp'; comp: Id; compound?: boolean }
  | ({ type: 'camera' } & CameraProps)
  | ({ type: 'light' } & LightProps)
  | ({ type: 'mesh' } & MeshProps)
  | ({ type: 'particles' } & ParticleProps)
  | ({ type: 'generator' } & GeneratorProps);

export interface Layer {
  id: Id; name: string; kind: LayerKind; start: number; duration: number; sourceIn: number; speed: number; reverse: boolean;
  freezeAt?: number | null; timeRemap?: Prop<number> | null; visible: boolean; locked: boolean; solo: boolean; muted: boolean; shy: boolean;
  label?: string | null; group?: Id | null; parent?: Id | null; is3d: boolean; blend: BlendMode; transform: Transform;
  effects: Effect[]; masks: Mask[]; trackMatte?: TrackMatte | null; audio: AudioProps; motionBlur: boolean;
  transitionIn?: Transition | null; transitionOut?: Transition | null; markers: Marker[]; material: Material;
}

export interface Project {
  schemaVersion: number; id: Id; name: string; assets: Asset[]; folders: Folder[]; compositions: Composition[];
  activeComp: Id; meta: Record<string, string>;
}

// ---------- registry (from registry_effects)
export type ParamKind =
  | { type: 'float'; min: number; max: number; step: number; unit?: string }
  | { type: 'angle' } | { type: 'color' } | { type: 'point'; relative: boolean } | { type: 'bool' }
  | { type: 'choice'; options: string[] } | { type: 'curve' } | { type: 'file'; extensions: string[] };
export interface ParamDef { key: string; label: string; kind: ParamKind; default: ParamValue; advanced?: boolean }
export interface EffectDef { kind: string; name: string; category: string; description: string; shader: number; audio: boolean; params: ParamDef[] }

export const LABEL_COLORS: Record<string, string> = {
  rose: '#F28D96', amber: '#E7B46A', sage: '#8FBF9A', sky: '#7FB2E5', lilac: '#B29BE0', sand: '#CDBB9A', slate: '#8C96A3',
};
