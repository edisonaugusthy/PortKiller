export const WINDOWS_SOURCE = 'windows-source.txt';
export const MACOS_SOURCE = 'macos-source.txt';

export function verifyReleaseSource(windowsSource, macSource) {
  const windows = windowsSource.trim();
  if (!/^[0-9a-f]{40}$/.test(windows)) throw new Error('The draft has no valid Windows build commit.');
  if (macSource.trim() !== windows) throw new Error(`Build the Mac release from a clean checkout of the Windows build commit ${windows}.`);
  return windows;
}
