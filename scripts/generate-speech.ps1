param(
  [Parameter(Mandatory=$true)][string]$InputText,
  [Parameter(Mandatory=$true)][string]$OutputAudio
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$compatSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($compatSpeaker.GetInstalledVoices().Count -eq 0) {
    throw 'SPEECH_FIXTURE_UNAVAILABLE: No Windows speech voice is installed.'
  }
  $compatSpeaker.Rate = -1
  $compatSpeaker.SetOutputToWaveFile($OutputAudio)
  $compatSpeaker.Speak([System.IO.File]::ReadAllText($InputText))
} finally {
  $compatSpeaker.Dispose()
}
