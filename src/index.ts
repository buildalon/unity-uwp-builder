import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from './glob';
import * as path from 'path';
import * as fs from 'fs';

const main = async () => {
    try {
        if (process.platform !== `win32`) { throw new Error(`This action can only run on Windows runner.`); }
        let projectPath = core.getInput(`project-path`, { required: true });
        core.info(`project-path: "${projectPath}"`);
        if (!projectPath.endsWith(`.sln`)) {
            projectPath = path.join(projectPath, `**/*.sln`);
        }
        let solution = projectPath;
        if (projectPath.includes('*')) {
            const globber = await glob.create(projectPath, { matchDirectories: false });
            const files = await globber.glob();
            core.startGroup(`Found solution files:`);
            files.forEach(file => core.info(`  - "${file}"`));
            core.endGroup();
            if (files.length === 0) { throw new Error(`No solution file found.`); }
            solution = files[0];
        }
        core.info(`Building ${solution}...`);
        projectPath = path.dirname(solution);
        try {
            await fs.promises.access(solution, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Solution file not found: "${solution}"`);
        }
        // packages from an earlier build of the same export must not be picked up as this build's output
        for (const appPackagesPath of await findAppPackagesDirectories(projectPath)) {
            core.info(`Cleaning AppPackages directory: ${appPackagesPath}...`);
            await fs.promises.rm(appPackagesPath, { recursive: true, force: true });
        }
        const vcxprojGlobber = await glob.create(path.join(projectPath, `**/*.vcxproj`), { matchDirectories: false });
        const vcxprojFiles = await vcxprojGlobber.glob();
        if (vcxprojFiles.length === 0) {
            throw new Error(`No VCXProj file found in: "${projectPath}"`);
        }
        core.startGroup(`Found VCXProj files:`);
        vcxprojFiles.forEach(file => core.info(`  - "${file}"`));
        core.endGroup();
        // the app project is the one next to the app manifest, not the IL2CPP output or a native plugin project
        const vcxprojPath = vcxprojFiles.find(file => fs.existsSync(path.join(path.dirname(file), `Package.appxmanifest`)))
            ?? vcxprojFiles.find(file => !path.basename(file).includes(`Il2CppOutputProject`));
        if (!vcxprojPath) {
            throw new Error(`No app VCXProj file found next to a Package.appxmanifest in: "${projectPath}"`);
        }
        core.info(`Using VCXProj: ${vcxprojPath}`);
        const configuration = core.getInput(`configuration`, { required: true });
        core.info(`configuration: "${configuration}"`);
        const buildArgs = [
            `/t:Build`,
            `/p:AppxBundle=Always`,
            `/p:Configuration=${configuration}`
        ];
        const platform = core.getInput(`platform`) || core.getInput(`architecture`);
        if (platform) {
            core.info(`platform: "${platform}"`);
            buildArgs.push(`/p:Platform=${platform}`);
        }
        const packageType = core.getInput(`package-type`, { required: true });
        core.info(`package-type: "${packageType}"`);
        switch (packageType) {
            case `upload`:
                buildArgs.push(`/p:UapAppxPackageBuildMode=StoreUpload`);
                break;
            case `sideload`:
                buildArgs.push(`/p:UapAppxPackageBuildMode=SideloadOnly`);
                break;
            default:
                throw new Error(`Invalid package type: "${packageType}"`);
        }
        const storeAssociationPath = core.getInput(`store-association-path`);
        // the store association moves the manifest to the Store publisher, which Unity's test certificate does not
        // match, and the Store signs what it publishes, so an associated upload with no certificate stays unsigned
        if (packageType === `upload` && storeAssociationPath && !core.getInput(`certificate-path`).trim()) {
            core.info(`Store associated upload with no certificate-path: the package is left unsigned for the Store to sign.`);
            buildArgs.push(
                `/p:GenerateTestCertificate=false`,
                `/p:AppxPackageSigningEnabled=false`
            );
        } else {
            const certificatePath = await getCertificatePath(projectPath);
            buildArgs.push(
                `/p:GenerateTestCertificate=false`,
                `/p:AppxPackageSigningEnabled=true`,
                `/p:PackageCertificateThumbprint=""`, // intentionally empty to force cert verification
                `/p:PackageCertificateKeyFile="${certificatePath}"`
            );
            // a password may start or end with spaces
            const certificatePassword = core.getInput(`certificate-password`, { trimWhitespace: false });
            if (certificatePassword) {
                core.setSecret(certificatePassword);
                buildArgs.push(`/p:PackageCertificatePassword="${certificatePassword}"`);
            }
        }
        if (storeAssociationPath) {
            core.info(`store-association-path: "${storeAssociationPath}"`);
            await copyAndEnsureStoreAssociation(vcxprojPath, storeAssociationPath);
        }
        const specifiedSDKVersion = core.getInput(`windows-sdk-version`);
        let windowsSDKVersion: string | null = null;
        if (specifiedSDKVersion) {
            if (await isWindowsSDKVersionAvailable(specifiedSDKVersion)) {
                windowsSDKVersion = specifiedSDKVersion;
                core.info(`Using specified Windows SDK version: ${windowsSDKVersion}`);
            } else {
                core.warning(`Specified Windows SDK version ${specifiedSDKVersion} not found. Falling back to auto-detection.`);
                windowsSDKVersion = await getAvailableWindowsSDKVersion();
            }
        } else {
            windowsSDKVersion = await getAvailableWindowsSDKVersion();
            if (windowsSDKVersion) {
                core.info(`Auto-detected Windows SDK version: ${windowsSDKVersion}`);
            }
        }
        if (windowsSDKVersion) {
            buildArgs.push(`/p:WindowsTargetPlatformVersion=${windowsSDKVersion}`);
            // SDK 10.0.26100.0 and newer no longer ship the WindowsMobile extension SDK
            const match = windowsSDKVersion.match(/^10\.0\.(\d+)\.\d+$/);
            if (match && parseInt(match[1], 10) >= 26100) {
                core.startGroup(`Removing WindowsMobile SDKReference from all VCXProj files...`);
                try {
                    for (const file of vcxprojFiles) {
                        await removeWindowsMobileSDKReference(file);
                    }
                } finally {
                    core.endGroup();
                }
            }
        }
        const platformToolset = await getPlatformToolsetOverride(projectPath, platform);
        if (platformToolset) {
            buildArgs.push(`/p:PlatformToolset=${platformToolset}`);
        }
        const additionalArgs = core.getInput(`additional-args`);
        if (additionalArgs) {
            core.info(`additional-args: "${additionalArgs}"`);
            buildArgs.push(...additionalArgs.split(` `).filter(arg => arg.length > 0));
        }
        if (!core.isDebug()) {
            buildArgs.push(`/verbosity:minimal`);
        }
        core.startGroup(`Final MSBuild arguments:`);
        buildArgs.forEach(arg => core.info(`  ${arg}`));
        core.endGroup();
        await exec.exec(`msbuild`, [`"${solution}"`, ...buildArgs], {
            windowsVerbatimArguments: true
        });
        const outputDirectory = await findAppPackagesDirectory(projectPath);
        core.info(`output-directory: ${outputDirectory}`);
        core.setOutput(`output-directory`, outputDirectory);
        const allGlobber = await glob.create(path.join(outputDirectory, `**/*`));
        const allFiles = await allGlobber.glob();
        core.startGroup(`All files found in output directory:`);
        allFiles.forEach(file => core.info(`  - "${file}"`));
        core.endGroup();
        const bundleExts = [`appxupload`, `msixupload`, `appxbundle`, `msixbundle`, `appx`, `msix`];
        const bundles = allFiles.filter(file =>
            bundleExts.some(ext => file.toLowerCase().endsWith(`.${ext}`)) &&
            !file.split(path.sep).some(part => part.toLowerCase() === `dependencies`));
        if (bundles.length === 0) {
            throw new Error(`No bundle files found in output directory: "${outputDirectory}"!`);
        }
        core.startGroup(`Found bundles:`);
        bundles.forEach(bundle => core.info(`  - "${bundle}"`));
        core.endGroup();
        core.setOutput(`bundles`, JSON.stringify(bundles));
        const executableExts = packageType === `upload`
            ? [`.appxupload`, `.msixupload`]
            : [`.appxbundle`, `.msixbundle`, `.appx`, `.msix`];
        const executable = executableExts
            .map(ext => bundles.find(bundle => bundle.toLowerCase().endsWith(ext)))
            .find(bundle => bundle !== undefined);
        core.info(`executable: ${executable}`);
        core.setOutput(`executable`, executable);
    } catch (error) {
        core.setFailed(error);
    }
}

main();

async function findAppPackagesDirectories(projectPath: string): Promise<string[]> {
    const globber = await glob.create(path.join(projectPath, `**`, `AppPackages`), { matchDirectories: true, implicitDescendants: false });
    const directories = await globber.glob();
    return directories.filter(directory => fs.statSync(directory).isDirectory());
}

async function findAppPackagesDirectory(projectPath: string): Promise<string> {
    const outputDirectory = (await findAppPackagesDirectories(projectPath))[0];
    if (!outputDirectory) {
        throw new Error(`AppPackages directory not found.`);
    }
    return outputDirectory;
}

async function getCertificatePath(projectPath: string): Promise<string> {
    let certificatePath = core.getInput(`certificate-path`).trim() || `${projectPath}/**/*.pfx`;
    core.info(`certificate-path: "${certificatePath}"`);
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
        const unityCertificate = certificateFiles.find(file => file.includes(`_TemporaryKey.pfx`) || file.includes(`TestCertificate.pfx`));
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

/**
 * Copies the store association file into the project directory, references it from the vcxproj, and matches the
 * appxmanifest identity and bundle platforms to it.
 */
async function copyAndEnsureStoreAssociation(vcxprojPath: string, sourcePath: string): Promise<void> {
    const packageStoreAssociationFilePath = path.join(path.dirname(vcxprojPath), `Package.StoreAssociation.xml`);
    await fs.promises.copyFile(sourcePath, packageStoreAssociationFilePath);
    let vcxprojFileContent: string = await fs.promises.readFile(vcxprojPath, `utf8`);
    if (!vcxprojFileContent.includes(`Package.StoreAssociation.xml`)) {
        core.info(`Package.StoreAssociation.xml not referenced in vcxproj, updating...`);
        const itemGroup = `  <ItemGroup>\n    <None Include="Package.StoreAssociation.xml" />\n  </ItemGroup>\n`;
        vcxprojFileContent = vcxprojFileContent.replace(`</Project>`, `${itemGroup}</Project>`);
        await fs.promises.writeFile(vcxprojPath, vcxprojFileContent, `utf8`);
        core.info(`Updated ${vcxprojPath} to include StoreAssociationFile reference.`);
    }
    const appxManifestPath = path.join(path.dirname(vcxprojPath), `Package.appxmanifest`);
    // match the appxmanifest identity and display name to the store association, keeping the version
    try {
        const storeAssociationContent = await fs.promises.readFile(packageStoreAssociationFilePath, `utf8`);
        const nameMatch = /<MainPackageIdentityName>([^<]+)<\/MainPackageIdentityName>/.exec(storeAssociationContent);
        const publisherMatch = /<Publisher>([^<]+)<\/Publisher>/.exec(storeAssociationContent);
        let reservedNameMatch: RegExpExecArray | null = null;
        const reservedNamesBlock = /<ReservedNames>([\s\S]*?)<\/ReservedNames>/.exec(storeAssociationContent);
        if (reservedNamesBlock) {
            reservedNameMatch = /<ReservedName>([^<]+)<\/ReservedName>/.exec(reservedNamesBlock[1]);
        }
        const displayNameMatch = /<DisplayName>([^<]+)<\/DisplayName>/.exec(storeAssociationContent);
        if (nameMatch && publisherMatch) {
            const name = nameMatch[1];
            const publisher = publisherMatch[1];
            // the display name must match the reserved name exactly, or packaging fails with APPX1607
            const displayName = reservedNameMatch ? reservedNameMatch[1] : (displayNameMatch ? displayNameMatch[1] : name);
            let appxManifestContent = await fs.promises.readFile(appxManifestPath, `utf8`);
            const identity = findIdentityElement(appxManifestContent);
            if (!identity) {
                throw new Error(`No Identity element found in ${appxManifestPath}`);
            }
            const updatedIdentity = setXmlAttribute(setXmlAttribute(identity, `Name`, name), `Publisher`, publisher);
            appxManifestContent = appxManifestContent.replace(identity, () => updatedIdentity);
            appxManifestContent = appxManifestContent.replace(
                /(<Properties[\s\S]*?<DisplayName>)([\s\S]*?)(<\/DisplayName>)/,
                (_match, before, _oldDisplayName, after) => `${before}${displayName}${after}`
            );
            await fs.promises.writeFile(appxManifestPath, appxManifestContent, `utf8`);
            core.info(`Updated Package.appxmanifest Identity with Name and Publisher from StoreAssociationFile.`);
            core.info(`Updated Package.appxmanifest DisplayName to: ${displayName}`);
        } else {
            core.warning(`Could not find MainPackageIdentityName or Publisher in StoreAssociationFile.`);
        }
    } catch (error) {
        throw new Error(`Failed to copy StoreAssociationFile:\n${error}`);
    }
    // match the store association's package version to the appxmanifest
    try {
        const appxManifestContent = await fs.promises.readFile(appxManifestPath, `utf8`);
        const identity = findIdentityElement(appxManifestContent);
        const version = identity ? getXmlAttribute(identity, `Version`) : undefined;
        if (version) {
            let storeAssociationContent = await fs.promises.readFile(packageStoreAssociationFilePath, `utf8`);
            storeAssociationContent = storeAssociationContent.replace(/<PackageMaxArchitectureVersion>[^<]+<\/PackageMaxArchitectureVersion>/g, `<PackageMaxArchitectureVersion>${version}</PackageMaxArchitectureVersion>`);
            await fs.promises.writeFile(packageStoreAssociationFilePath, storeAssociationContent, `utf8`);
            core.info(`Updated all PackageMaxArchitectureVersion tags in ${packageStoreAssociationFilePath} with Version from Package.appxmanifest.`);
        } else {
            core.warning(`No Identity found in Package.appxmanifest.`);
        }
    } catch (error) {
        throw new Error(`Failed to update StoreAssociationFile with Version from Package.appxmanifest:\n${error}`);
    }
    // bundle the platforms the store association lists
    try {
        const storeAssociationContent = await fs.promises.readFile(packageStoreAssociationFilePath, `utf8`);
        const archRegex = /<PackageArchitecture>([^<]+)<\/PackageArchitecture>/gi;
        const architectures: string[] = [];
        let archMatch: RegExpExecArray | null;
        while ((archMatch = archRegex.exec(storeAssociationContent)) !== null) {
            architectures.push(archMatch[1]);
        }
        const archMap: Record<string, string> = {
            'x86': 'x86',
            'x64': 'x64',
            'arm': 'ARM',
            'arm64': 'ARM64'
        };
        // the association also lists neutral, which is no msbuild platform
        const msbuildArchs = [...new Set(architectures.map(arch => archMap[arch.trim().toLowerCase()]).filter(arch => arch !== undefined))];
        if (msbuildArchs.length > 0) {
            const appxBundlePlatformsValue = msbuildArchs.join(`|`);
            let vcxprojContent = await fs.promises.readFile(vcxprojPath, `utf8`);
            if (vcxprojContent.includes(`<AppxBundlePlatforms>`)) {
                vcxprojContent = vcxprojContent.replace(/<AppxBundlePlatforms>[^<]*<\/AppxBundlePlatforms>/, `<AppxBundlePlatforms>${appxBundlePlatformsValue}</AppxBundlePlatforms>`);
            } else {
                vcxprojContent = vcxprojContent.replace(/(<PropertyGroup[^>]*>)/, `$1\n    <AppxBundlePlatforms>${appxBundlePlatformsValue}</AppxBundlePlatforms>`);
            }
            await fs.promises.writeFile(vcxprojPath, vcxprojContent, `utf8`);
            core.info(`Set AppxBundlePlatforms in ${vcxprojPath} to: ${appxBundlePlatformsValue}`);
        } else {
            core.warning(`No x86, x64, ARM or ARM64 <PackageArchitecture> found in StoreAssociationFile. AppxBundlePlatforms not set.`);
        }
    } catch (error) {
        throw new Error(`Failed to set AppxBundlePlatforms in vcxproj:\n${error}`);
    }
    for (const file of [vcxprojPath, packageStoreAssociationFilePath, appxManifestPath]) {
        core.startGroup(`--- ${file} file contents ---`);
        core.info(await fs.promises.readFile(file, `utf8`));
        core.endGroup();
    }
}

/** The Identity start tag of an appxmanifest, whatever the order, spacing or line breaks of its attributes. */
function findIdentityElement(manifest: string): string | undefined {
    return /<Identity\b[^>]*>/.exec(manifest)?.[0];
}

function getXmlAttribute(element: string, attribute: string): string | undefined {
    return new RegExp(`\\s${attribute}\\s*=\\s*(["'])(.*?)\\1`).exec(element)?.[2];
}

function escapeXmlAttribute(value: string): string {
    return value.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, `&amp;`).replace(/"/g, `&quot;`).replace(/</g, `&lt;`);
}

function setXmlAttribute(element: string, attribute: string, value: string): string {
    const escaped = escapeXmlAttribute(value);
    const pattern = new RegExp(`(\\s${attribute}\\s*=\\s*)(["']).*?\\2`);
    if (pattern.test(element)) {
        return element.replace(pattern, (_match, before) => `${before}"${escaped}"`);
    }
    return element.replace(/^<Identity\b/, match => `${match} ${attribute}="${escaped}"`);
}

const windowsKitPaths = [
    `C:\\Program Files (x86)\\Windows Kits\\10\\Include`,
    `C:\\Program Files\\Windows Kits\\10\\Include`
];

async function isWindowsSDKVersionAvailable(version: string): Promise<boolean> {
    for (const basePath of windowsKitPaths) {
        const versionPath = path.join(basePath, version);
        try {
            await fs.promises.access(versionPath, fs.constants.R_OK);
            core.info(`Found Windows SDK version ${version} at: ${versionPath}`);
            return true;
        } catch (error) {
            continue;
        }
    }
    core.info(`Windows SDK version ${version} not found in standard locations`);
    return false;
}

async function getAvailableWindowsSDKVersion(): Promise<string | null> {
    const allVersions: string[] = [];
    for (const basePath of windowsKitPaths) {
        try {
            const entries = await fs.promises.readdir(basePath);
            const versions = entries.filter(entry => /^10\.0\.\d+\.\d+$/.test(entry));
            allVersions.push(...versions);
            core.info(`Found Windows SDK versions in ${basePath}:`);
            versions.forEach(version => core.info(`  - ${version}`));
        } catch (error) {
            core.info(`Path not accessible: ${basePath}`);
        }
    }
    if (allVersions.length === 0) {
        core.warning(`No Windows SDK versions found in standard installation paths. Build may fail if Unity references an unavailable SDK version.`);
        return null;
    }
    const uniqueVersions = [...new Set(allVersions)].sort((a, b) => {
        const aParts = a.split(`.`).map(Number);
        const bParts = b.split(`.`).map(Number);
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const diff = (bParts[i] || 0) - (aParts[i] || 0);
            if (diff !== 0) { return diff; }
        }
        return 0;
    });
    return uniqueVersions[0];
}

async function removeWindowsMobileSDKReference(vcxprojPath: string): Promise<void> {
    try {
        const vcxprojContent = await fs.promises.readFile(vcxprojPath, `utf8`);
        const updatedContent = vcxprojContent.replace(
            /<SDKReference\s+Include=["']WindowsMobile[^"']*["'][^>]*\/>|<SDKReference\s+Include=["']WindowsMobile[^"']*["'][^>]*>[\s\S]*?<\/SDKReference>/gi,
            ``
        );
        if (vcxprojContent !== updatedContent) {
            await fs.promises.writeFile(vcxprojPath, updatedContent, `utf8`);
            core.info(`Removed WindowsMobile SDKReference from ${vcxprojPath}`);
        } else {
            core.info(`No WindowsMobile SDKReference found in ${vcxprojPath}`);
        }
    } catch (error) {
        throw new Error(`Failed to remove WindowsMobile SDKReference: ${error.message}`);
    }
}

async function getPlatformToolsetOverride(projectPath: string, platform: string): Promise<string | undefined> {
    const projectGlobber = await glob.create(`${projectPath}/**/*.vcxproj`);
    const projectFiles = await projectGlobber.glob();
    const requiredToolsets = new Set<string>();
    const projectPlatforms = new Set<string>();
    for (const projectFile of projectFiles) {
        const contents = await fs.promises.readFile(projectFile, `utf8`);
        for (const match of contents.matchAll(/<PlatformToolset>\s*(v\d+)\s*<\/PlatformToolset>/g)) {
            requiredToolsets.add(match[1]);
        }
        for (const match of contents.matchAll(/<ProjectConfiguration\s+Include="[^"|]*\|([^"]+)"/g)) {
            projectPlatforms.add(match[1]);
        }
    }
    if (requiredToolsets.size === 0) { return undefined; }
    core.debug(`Required platform toolsets: ${[...requiredToolsets].join(`, `)}`);
    // without a platform, every platform the project builds needs the toolset
    const platforms = platform ? [platform] : [...projectPlatforms];
    let installedToolsets: string[] = [];
    if (platforms.length === 0) {
        installedToolsets = await getInstalledUwpToolsets(undefined);
    } else {
        for (const [index, buildPlatform] of platforms.entries()) {
            const toolsets = await getInstalledUwpToolsets(buildPlatform);
            installedToolsets = index === 0 ? toolsets : installedToolsets.filter(toolset => toolsets.includes(toolset));
        }
    }
    if (installedToolsets.length === 0) {
        core.debug(`Unable to determine installed UWP platform toolsets.`);
        return undefined;
    }
    core.debug(`Installed UWP platform toolsets: ${installedToolsets.join(`, `)}`);
    if ([...requiredToolsets].every(toolset => installedToolsets.includes(toolset))) { return undefined; }
    const latestToolset = installedToolsets[installedToolsets.length - 1];
    core.info(`Platform toolset ${[...requiredToolsets].join(`, `)} is not installed, using ${latestToolset} instead.`);
    return latestToolset;
}

async function getInstalledUwpToolsets(platform: string | undefined): Promise<string[]> {
    let installationPath = ``;
    const vswhere = path.join(process.env[`ProgramFiles(x86)`] || `C:\\Program Files (x86)`, `Microsoft Visual Studio`, `Installer`, `vswhere.exe`);
    try {
        await exec.exec(`"${vswhere}"`, [`-latest`, `-products`, `*`, `-requires`, `Microsoft.Component.MSBuild`, `-property`, `installationPath`], {
            silent: true,
            listeners: {
                stdout: (data: Buffer) => {
                    installationPath += data.toString();
                }
            }
        });
    } catch (error) {
        return [];
    }
    installationPath = installationPath.trim().split(/\r?\n/)[0];
    if (!installationPath) { return []; }
    // msbuild keeps the x86 toolsets under Win32
    const platformDirectory = !platform ? `*` : platform.toLowerCase() === `x86` ? `Win32` : platform;
    const toolsetGlobber = await glob.create(`${installationPath}/MSBuild/Microsoft/VC/*/Application Type/Windows Store/10.0/Platforms/${platformDirectory}/PlatformToolsets/v*`, { matchDirectories: true, implicitDescendants: false });
    const toolsetPaths = await toolsetGlobber.glob();
    const toolsets = [...new Set(toolsetPaths.map(toolsetPath => path.basename(toolsetPath)))];
    return toolsets.sort((a, b) => parseInt(a.substring(1)) - parseInt(b.substring(1)));
}
