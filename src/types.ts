export type Configuration = 'Debug' | 'Release' | 'Master';
export type PackageType = 'sideload' | 'upload';
export type BuildPlatform = 'x86' | 'x64' | 'ARM' | 'ARM64';
export class UwpProject {
  constructor(
    public projectDirectory: string,
    public projectSolutionPath: string,
    public projectName: string,
    public projectVcxProjPath: string,
    public il2cppOutputProjectVcxProjPath: string,
    public packageType: PackageType,
    public outputDirectory: string | null,
    public configuration: Configuration,
    public buildPlatform: BuildPlatform[],
    public certificatePath?: string | null,
    public certificatePassword?: string | null,
    public windowsSdkVersion?: string | null
  ) {
  }
}