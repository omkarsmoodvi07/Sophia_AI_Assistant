export type SophiaVoiceProfile = {
  id: string
  label: string
  language: string
  voice: string
}

export const SOPHIA_VOICE_PROFILES: SophiaVoiceProfile[] = [
  {
    id: 'en-indian-female',
    label: '🇮🇳 Indian English — Female',
    language: 'en-IN',
    voice: 'en-IN-NeerjaExpressiveNeural',
  },
  {
    id: 'en-indian-male',
    label: '🇮🇳 Indian English — Male',
    language: 'en-IN',
    voice: 'en-IN-PrabhatNeural',
  },
  {
    id: 'kn-female',
    label: 'ಕನ್ನಡ Kannada — Female',
    language: 'kn-IN',
    voice: 'kn-IN-SapnaNeural',
  },
  {
    id: 'kn-male',
    label: 'ಕನ್ನಡ Kannada — Male',
    language: 'kn-IN',
    voice: 'kn-IN-GaganNeural',
  },
  {
    id: 'hi-female',
    label: 'हिंदी Hindi — Female',
    language: 'hi-IN',
    voice: 'hi-IN-SwaraNeural',
  },
  {
    id: 'hi-male',
    label: 'हिंदी Hindi — Male',
    language: 'hi-IN',
    voice: 'hi-IN-MadhurNeural',
  },
]

export const DEFAULT_SOPHIA_VOICE_PROFILE = 'en-indian-female'

export function getSophiaVoiceProfile(id: string) {
  return (
    SOPHIA_VOICE_PROFILES.find(profile => profile.id === id) ??
    SOPHIA_VOICE_PROFILES.find(
      profile => profile.id === DEFAULT_SOPHIA_VOICE_PROFILE,
    )!
  )
}
