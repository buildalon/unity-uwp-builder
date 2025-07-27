import core = require('@actions/core');
import fs = require('fs');
import path = require('path');
import glob = require('@actions/glob');
import {
  BuildPlatform,
  Configuration,
  PackageType,
  UwpProject
} from "./types";
import {
  getAvailableWindowsSDKVersion,
  isWindowsSDKVersionAvailable,
  removeWindowsMobileSDKReference,
  associateAppWithStore
} from './utils';

export async function getUwpProjectInputs(): Promise<UwpProject> {
  let projectDirectory = core.getInput(`project-path`, { required: true });
  core.info(`project-path: "${projectDirectory}"`);
  if (!projectDirectory.endsWith(`.sln`)) {
    projectDirectory = path.join(projectDirectory, `**/*.sln`);
  }
  let projectSolutionPath = projectDirectory;
  if (projectDirectory.includes('*')) {
    const globber = await glob.create(projectDirectory, { matchDirectories: false });
    const files = await globber.glob();
    core.startGroup(`Found solution files:`);
    files.forEach(file => core.info(`  - "${file}"`));
    core.endGroup();
    if (files.length === 0) { throw new Error(`No solution file found.`); }
    projectSolutionPath = files[0];
  }
  core.info(`projectSolutionPath: "${projectSolutionPath}"`);
  projectDirectory = path.dirname(projectSolutionPath);
  core.info(`projectDirectory: "${projectDirectory}"`);
  const projectName = path.basename(projectDirectory);
  core.info(`projectName: "${projectName}"`);
  try {
    await fs.promises.access(projectSolutionPath, fs.constants.R_OK);
  } catch (error) {
    throw new Error(`Solution file not found: "${projectSolutionPath}"`);
  }
  let outputDirectory: string;
  const outputDirectoryInput = core.getInput('output-directory');
  if (outputDirectoryInput) {
    outputDirectory = outputDirectoryInput;
  } else {
    outputDirectory = path.join(projectDirectory, `AppPackages`);
  }
  core.info(`outputDirectory: "${outputDirectory}"`);
  const vcxprojGlobber = await glob.create(path.join(projectDirectory, '**/*.vcxproj'), { matchDirectories: false });
  const vcxprojFiles = await vcxprojGlobber.glob();
  if (vcxprojFiles.length === 0) {
    throw new Error(`No vcxproj file found in: "${projectDirectory}"`);
  }
  core.startGroup(`Found vcxproj files:`);
  vcxprojFiles.forEach(file => core.info(`  - "${file}"`));
  core.endGroup();
  let vcxprojPath: string | null = null;
  let il2cppOutputProjectVcxProjPath: string | null = null;
  for (const file of vcxprojFiles) {
    if (!il2cppOutputProjectVcxProjPath && path.basename(file).includes('Il2CppOutputProject')) {
      il2cppOutputProjectVcxProjPath = file;
    }
    if (!vcxprojPath) {
      vcxprojPath = file;
    }
  }
  if (!vcxprojPath) {
    throw new Error(`Failed to find ${projectName}.vcxproj file!`);
  }
  if (!il2cppOutputProjectVcxProjPath) {
    throw new Error(`Failed to find Il2CppOutputProject.vcxproj file!`);
  }
  core.info(`Using vcxproj: ${vcxprojPath}`);
  await fs.promises.access(vcxprojPath, fs.constants.R_OK | fs.constants.W_OK);
  const stat = await fs.promises.stat(vcxprojPath);
  if (!stat.isFile()) {
    throw new Error(`vcxproj file not found or is not a valid file: "${vcxprojPath}"`);
  }
  const configuration = core.getInput(`configuration`, { required: true }) as Configuration;
  if (!['Debug', 'Release', 'Master'].includes(configuration)) {
    throw new Error(`Invalid configuration: "${configuration}". Must be one of 'Debug', 'Release', or 'Master'.`);
  }
  core.info(`configuration: "${configuration}"`);
  const packageType = core.getInput(`package-type`, { required: true }) as PackageType;
  if (!['sideload', 'upload'].includes(packageType)) {
    throw new Error(`Invalid package type: "${packageType}". Must be 'sideload' or 'upload'.`);
  }
  core.info(`packageType: "${packageType}"`);
  // input can be a single platform, comma-separated list, an array, or a `|` separated list
  const buildPlatformInput = core.getInput('platform', { required: false })?.split(/[,|]/).map(p => p.trim()) || [];
  const buildPlatform: BuildPlatform[] = [];
  for (const platform of buildPlatformInput) {
    if (!['x86', 'x64', 'ARM', 'ARM64'].includes(platform)) {
      throw new Error(`Invalid build platform: "${platform}". Must be one of 'x86', 'x64', 'ARM', or 'ARM64'.`);
    }
    buildPlatform.push(platform as BuildPlatform);
  }
  const certificatePath = await getSigningCertificatePath(projectDirectory);
  const certificatePassword = core.getInput(`certificate-password`);
  const storeAssociationPath = core.getInput('store-association-path', { required: packageType === 'upload' });
  if (storeAssociationPath) {
    core.info(`store-association-path: "${storeAssociationPath}"`);
    await fs.promises.access(storeAssociationPath, fs.constants.R_OK);
    await associateAppWithStore(vcxprojPath, storeAssociationPath);
  }
  const specifiedSDKVersion = core.getInput(`windows-sdk-version`);
  let windowsSDKVersion: string | null = null;
  if (specifiedSDKVersion && await isWindowsSDKVersionAvailable(specifiedSDKVersion)) {
    windowsSDKVersion = specifiedSDKVersion;
    core.info(`Using specified Windows SDK version: ${windowsSDKVersion}`);
  } else {
    windowsSDKVersion = await getAvailableWindowsSDKVersion();
    core.info(`Using latest available Windows SDK version: ${windowsSDKVersion}`);
  }
  if (windowsSDKVersion) {
    const match = windowsSDKVersion.match(/^10\.0\.(\d+)\.\d+$/);
    // WindowsMobile SDKReference is no longer supported in Windows SDK versions >= 10.0.26100.0
    if (match && parseInt(match[1], 10) >= 26100) {
      core.startGroup('Removing WindowsMobile SDKReference from all VCXProj files...');
      await removeWindowsMobileSDKReference(vcxprojPath);
      await removeWindowsMobileSDKReference(il2cppOutputProjectVcxProjPath);
      core.endGroup();
    }
  }
  return new UwpProject(
    projectDirectory,
    projectSolutionPath,
    path.basename(projectDirectory), // projectName
    vcxprojPath,
    il2cppOutputProjectVcxProjPath,
    packageType,
    outputDirectory,
    configuration,
    buildPlatform,
    certificatePath,
    certificatePassword,
    windowsSDKVersion
  );
}
/**
 * Gets the path to the signing certificate for the exported UWP project.
 * If the `certificate-path` input is not provided, it defaults to searching for a `.pfx` file in the project directory.
 * If multiple `.pfx` files are found, it prefers Unity's generated certificate (e.g., `_TemporaryKey.pfx` or `TestCertificate.pfx`).
 * If no certificate is found, it throws an error.
 * @param projectPath The path to the project directory where the certificate is expected to be found.
 * @throws {Error} If no certificate file is found or if the certificate file is not readable.
 * @returns The path to the signing certificate.
 */
async function getSigningCertificatePath(projectPath: string): Promise<string> {
  let certificatePath = core.getInput(`certificate-path`);
  if (!certificatePath || certificatePath.trim() === ``) {
    certificatePath = `${projectPath}/**/*.pfx`;
  }
  core.info(`certificatePath: "${certificatePath}"`);
  if (!certificatePath.endsWith(`.pfx`)) {
    certificatePath = path.join(certificatePath, `**/*.pfx`);
  }
  if (certificatePath.includes(`*`)) {
    const certificateGlobber = await glob.create(certificatePath);
    const certificateFiles = await certificateGlobber.glob();
    core.info(`Found certificate files:`);
    certificateFiles.forEach(file => core.info(`  - "${file}"`));
    if (certificateFiles.length === 0) {
      throw new Error(`No certificate file found: "${certificatePath}". Make sure Unity generated a test certificate or provide a custom certificate path.`);
    }
    // Prefer Unity's generated certificate if multiple are found
    const unityCertificate = certificateFiles.find(file => file.includes('WSATestCertificate.pfx'));
    certificatePath = unityCertificate || certificateFiles[0];
  }
  try {
    await fs.promises.access(certificatePath, fs.constants.R_OK);
    const stat = await fs.promises.stat(certificatePath);
    if (!stat.isFile()) {
      throw new Error(`Certificate path is not a valid file: "${certificatePath}"`);
    }
  } catch (error) {
    throw new Error(`Certificate file not found: "${certificatePath}". Make sure the certificate exists and is readable.`);
  }
  core.info(`Using certificate: ${certificatePath}`);
  return certificatePath;
}