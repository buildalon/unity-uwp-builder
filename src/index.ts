import core = require('@actions/core');
import glob = require('@actions/glob');
import path = require('path');
import fs = require('fs');
import { exec } from '@actions/exec';

const main = async () => {
    try {
        if (process.platform !== `win32`) { throw new Error(`This action can only be performed on a Windows runner.`); }
        let projectPath = core.getInput(`project-path`, { required: true });
        core.debug(`project-path: "${projectPath}"`);
        if (!projectPath.endsWith(`.sln`)) {
            projectPath = path.join(projectPath, `**/*.sln`);
        }
        let solution = projectPath;
        if (projectPath.includes('*')) {
            const globber = await glob.create(projectPath, { matchDirectories: false });
            const files = await globber.glob();
            core.debug(`Found solution files:`);
            files.forEach(file => core.debug(`  - "${file}"`));
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
        const appPackagesPath = path.join(projectPath, `AppPackages`);
        if (fs.existsSync(appPackagesPath)) {
            core.info(`Cleaning AppPackages directory: ${appPackagesPath}...`);
            await fs.promises.rm(appPackagesPath, { recursive: true, force: true });
        }
        // Find any .vcxproj file in the solution directory or subdirectories
        const vcxprojGlobber = await glob.create(path.join(projectPath, '**/*.vcxproj'), { matchDirectories: false });
        const vcxprojFiles = await vcxprojGlobber.glob();
        if (vcxprojFiles.length === 0) {
            throw new Error(`No VCXProj file found in: "${projectPath}"`);
        }
        core.info(`Found VCXProj files:`);
        vcxprojFiles.forEach(file => core.info(`  - "${file}"`));
        const vcxprojPath = vcxprojFiles[0];
        core.info(`Using VCXProj: ${vcxprojPath}`);

        const configuration = core.getInput(`configuration`, { required: true });
        const buildArgs = [
            `/t:Build`,
            `/p:AppxBundle=Always`,
            `/p:Configuration=${configuration}`,
        ];
        const platform = core.getInput(`platform`);
        if (platform) {
            core.debug(`platform: "${platform}"`);
            buildArgs.push(`/p:Platform=${platform}`);
        }
        const packageType = core.getInput(`package-type`, { required: true });
        core.debug(`package-type: "${packageType}"`);
        core.info(`Requested package type: ${packageType}`);
        const certificatePath = await getCertificatePath(projectPath);
        switch (packageType) {
            case `upload`:
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=StoreUpload`,
                );
                break;
            case `sideload`:
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=SideloadOnly`,
                );
                break;
            default:
                throw new Error(`Invalid package type: "${packageType}"`);
        }
        buildArgs.push(
            `/p:GenerateTestCertificate=false`,
            `/p:AppxPackageSigningEnabled=true`,
            `/p:PackageCertificateThumbprint=""`, // intentionally empty to force cert verification
            `/p:PackageCertificateKeyFile="${certificatePath}"`,
        )
        const certificatePassword = core.getInput(`certificate-password`);
        if (certificatePassword) {
            buildArgs.push(`/p:PackageCertificatePassword="${certificatePassword}"`);
        }
        const additionalArgs = core.getInput(`additional-args`);
        if (additionalArgs) {
            core.debug(`additional-args: "${additionalArgs}"`);
            buildArgs.push(...additionalArgs);
        }
        // Copy StoreAssociationFile and update vcxproj if needed
        const storeAssociationPath = core.getInput('store-association-path');
        if (storeAssociationPath) {
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
        }
        if (windowsSDKVersion) {
            if (!specifiedSDKVersion) {
                core.info(`Auto-detected Windows SDK version: ${windowsSDKVersion}`);
            }
            buildArgs.push(`/p:WindowsTargetPlatformVersion=${windowsSDKVersion}`);
        }
        if (windowsSDKVersion) {
            // Use regex to extract the revision part and compare to 26100
            const match = windowsSDKVersion.match(/^10\.0\.(\d+)\.\d+$/);
            if (match && parseInt(match[1], 10) >= 26100) {
                await removeWindowsMobileSDKReference(vcxprojPath);
            }
        }
        if (!core.isDebug()) {
            buildArgs.push(`/verbosity:minimal`);
        }
        core.info(`Final MSBuild arguments:`);
        buildArgs.forEach(arg => core.info(`  ${arg}`));
        core.startGroup(`MSBuild`);
        try {
            await exec(`msbuild`, [`"${solution}"`, ...buildArgs], {
                windowsVerbatimArguments: true
            });
        } finally {
            core.endGroup();
        }
        // using the globber, find the AppPackages directory itself
        const appPackagesGlobber = await glob.create(path.join(projectPath, `**`, `*`), { matchDirectories: true });
        const appPackagesGlobs = await appPackagesGlobber.glob();
        const outputDirectory = appPackagesGlobs.find(glob => glob.includes(`AppPackages`));
        if (!outputDirectory) {
            throw new Error(`AppPackages directory not found.`);
        }
        // make sure the output directory exists and is valid
        try {
            await fs.promises.access(outputDirectory, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Output directory not found: "${outputDirectory}".`);
        }
        core.info(`outputDirectory: ${outputDirectory}`);
        core.setOutput(`output-directory`, outputDirectory);
        const allGlobber = await glob.create(path.join(outputDirectory, '**/*'));
        const allFiles = await allGlobber.glob();
        core.info(`All files found in output directory:`);
        allFiles.forEach(file => core.info(`  - "${file}"`));
        const bundleExts = ['appxupload', 'msixupload', 'appxbundle', 'msixbundle', 'appx', 'msix'];
        const bundles = allFiles.filter(f => bundleExts.some(ext => f.toLowerCase().endsWith(`.${ext}`)));
        if (bundles.length === 0) {
            throw new Error(`No bundle files found in output directory: "${outputDirectory}"!`);
        }
        core.info(`Found bundles:`);
        bundles.forEach(bundle => core.info(`  - "${bundle}"`));
        core.setOutput(`bundles`, JSON.stringify(bundles));
    } catch (error) {
        core.setFailed(error);
    }
}

main();

async function getCertificatePath(projectPath: string): Promise<string> {
    let certificatePath = core.getInput(`certificate-path`);
    if (!certificatePath || certificatePath.trim() === ``) {
        certificatePath = `${projectPath}/**/*.pfx`;
    }
    core.debug(`certificatePath: "${certificatePath}"`);
    if (!certificatePath.endsWith(`.pfx`)) {
        certificatePath = path.join(certificatePath, `**/*.pfx`);
    }
    if (certificatePath.includes(`*`)) {
        const certificateGlobber = await glob.create(certificatePath);
        const certificateFiles = await certificateGlobber.glob();
        core.debug(`Found certificate files:`);
        certificateFiles.forEach(file => core.debug(`  - "${file}"`));
        if (certificateFiles.length === 0) {
            throw new Error(`No certificate file found: "${certificatePath}". Make sure Unity generated a test certificate or provide a custom certificate path.`);
        }
        // Prefer Unity's generated certificate if multiple are found
        const unityCertificate = certificateFiles.find(file => file.includes('_TemporaryKey.pfx') || file.includes('TestCertificate.pfx'));
        certificatePath = unityCertificate || certificateFiles[0];
    }
    try {
        await fs.promises.access(certificatePath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Certificate file not found: "${certificatePath}". Make sure the certificate exists and is readable.`);
    }
    core.info(`Using certificate: ${certificatePath}`);
    return certificatePath;
}

/**
 * Copies StoreAssociationFile into the project directory and ensures it's referenced in the vcxproj
 */
async function copyAndEnsureStoreAssociation(vcxprojPath: string, sourcePath: string): Promise<void> {
    const destFile = path.join(path.dirname(vcxprojPath), 'Package.StoreAssociation.xml');
    try {
        // Copy file if not already present or if source is different
        if (!fs.existsSync(destFile) || (await fs.promises.readFile(destFile, 'utf8')) !== (await fs.promises.readFile(sourcePath, 'utf8'))) {
            await fs.promises.copyFile(sourcePath, destFile);
            core.info(`Copied StoreAssociationFile to ${destFile}`);
        } else {
            core.info(`StoreAssociationFile already exists and is up to date.`);
        }
    } catch (error) {
        core.warning(`Failed to copy StoreAssociationFile: ${error}`);
        return;
    }

    let content: string;
    try {
        content = await fs.promises.readFile(vcxprojPath, 'utf8');
    } catch (error) {
        core.warning(`Failed to read vcxproj file: ${error}`);
        return;
    }
    // Check if Package.StoreAssociation.xml is already referenced
    if (content.includes('Package.StoreAssociation.xml')) {
        core.info('Package.StoreAssociation.xml already referenced in vcxproj.');
        return;
    }
    core.info('Package.StoreAssociation.xml not referenced in vcxproj, updating...');
    // check the vcxproj if it contains a ItemGroup with the StoreAssociationFile
    const itemGroupRegex = /<ItemGroup>([\s\S]*?)<\/ItemGroup>/g;
    let itemGroupMatch: RegExpExecArray | null = null;
    let hasStoreAssociationFile: boolean = false;
    while ((itemGroupMatch = itemGroupRegex.exec(content)) !== null) {
        if (itemGroupMatch[1].includes('StoreAssociationFile')) {
            hasStoreAssociationFile = true;
            break;
        }
    }
    // If no ItemGroup with StoreAssociationFile, add it at before the </Project> tag
    if (!hasStoreAssociationFile) {
        const itemGroup = `  <ItemGroup>
    <None Include="Package.StoreAssociation.xml" />
  </ItemGroup>`;
        // Insert before the closing </Project> tag
        content = content.replace('</Project>', `${itemGroup}</Project>`);
    }

    // Write the updated content back to the vcxproj file
    try {
        await fs.promises.writeFile(vcxprojPath, content, 'utf8');
        core.info(`Updated ${vcxprojPath} to include StoreAssociationFile reference.`);
    } catch (error) {
        core.warning(`Failed to update ${vcxprojPath}: ${error}`);
    }
    // Step 1: Extract Identity info from StoreAssociationFile and update appxmanifest (without changing version)
    const appxManifestPath = path.join(path.dirname(vcxprojPath), 'Package.appxmanifest');
    try {
        const storeAssociationContent = await fs.promises.readFile(destFile, 'utf8');
        // Extract MainPackageIdentityName and Publisher from StoreAssociationFile
        const nameMatch = /<MainPackageIdentityName>([^<]+)<\/MainPackageIdentityName>/.exec(storeAssociationContent);
        const publisherMatch = /<Publisher>([^<]+)<\/Publisher>/.exec(storeAssociationContent);
        if (nameMatch && publisherMatch) {
            const name = nameMatch[1];
            const publisher = publisherMatch[1];
            // Read appxmanifest
            let appxManifestContent = await fs.promises.readFile(appxManifestPath, 'utf8');
            // Update Name and Publisher in <Identity> tag, but keep Version
            appxManifestContent = appxManifestContent.replace(
                /<Identity Name="([^"]+)" Publisher="([^"]+)" Version="([^"]+)" \/>/,
                (match, oldName, oldPublisher, version) => `<Identity Name="${name}" Publisher="${publisher}" Version="${version}" />`
            );
            await fs.promises.writeFile(appxManifestPath, appxManifestContent, 'utf8');
            core.info(`Updated Package.appxmanifest Identity with Name and Publisher from StoreAssociationFile.`);
        } else {
            core.warning(`Could not find MainPackageIdentityName or Publisher in StoreAssociationFile.`);
        }
    } catch (error) {
        core.warning(`Failed to update Package.appxmanifest Identity: ${error}`);
    }

    // Step 2: Extract Version from appxmanifest and update StoreAssociationFile
    try {
        const appxManifestContent = await fs.promises.readFile(appxManifestPath, 'utf8');
        const identityRegex = /<Identity Name="([^"]+)" Publisher="([^"]+)" Version="([^"]+)" \/>/;
        const match = identityRegex.exec(appxManifestContent);
        if (match) {
            const version = match[3];
            let storeAssociationContent = await fs.promises.readFile(destFile, 'utf8');
            storeAssociationContent = storeAssociationContent.replace(
                /<PackageMaxArchitectureVersion>[^<]+<\/PackageMaxArchitectureVersion>/,
                `<PackageMaxArchitectureVersion>${version}</PackageMaxArchitectureVersion>`
            );
            await fs.promises.writeFile(destFile, storeAssociationContent, 'utf8');
            core.info(`Updated ${destFile} with Version from Package.appxmanifest.`);
        } else {
            core.warning(`No Identity found in Package.appxmanifest.`);
        }
    } catch (error) {
        core.warning(`Failed to update StoreAssociationFile with version: ${error}`);
    }
}

/**
 * Checks if a specific Windows SDK version is available on the build machine
 */
async function isWindowsSDKVersionAvailable(version: string): Promise<boolean> {
    try {
        // Common Windows SDK installation paths
        const possiblePaths = [
            'C:\\Program Files (x86)\\Windows Kits\\10\\Include',
            'C:\\Program Files\\Windows Kits\\10\\Include'
        ];

        for (const basePath of possiblePaths) {
            try {
                const versionPath = path.join(basePath, version);
                await fs.promises.access(versionPath, fs.constants.R_OK);
                core.debug(`Found Windows SDK version ${version} at: ${versionPath}`);
                return true;
            } catch (error) {
                continue;
            }
        }

        core.debug(`Windows SDK version ${version} not found in standard locations`);
        return false;
    } catch (error) {
        core.debug(`Error checking Windows SDK version ${version}: ${error}`);
        return false;
    }
}

/**
 * Detects the available Windows SDK version on the build machine
 */
async function getAvailableWindowsSDKVersion(): Promise<string | null> {
    try {
        // Common Windows SDK installation paths
        const possiblePaths = [
            'C:\\Program Files (x86)\\Windows Kits\\10\\Include',
            'C:\\Program Files\\Windows Kits\\10\\Include'
        ];

        let allVersions: string[] = [];

        for (const basePath of possiblePaths) {
            try {
                await fs.promises.access(basePath, fs.constants.R_OK);
                const entries = await fs.promises.readdir(basePath);

                // Filter for version directories (format: 10.0.xxxxx.x)
                const versions = entries.filter(entry => /^10\.0\.\d+\.\d+$/.test(entry));
                allVersions.push(...versions);

                core.info(`Found Windows SDK versions in ${basePath}: ${versions.join(', ')}`);
            } catch (error) {
                core.debug(`Path not accessible: ${basePath}`);
                continue;
            }
        }

        if (allVersions.length === 0) {
            core.warning('No Windows SDK versions found in standard installation paths. Build may fail if Unity references an unavailable SDK version.');
            return null;
        }

        // Remove duplicates and sort versions in descending order to prefer the latest
        const uniqueVersions = [...new Set(allVersions)].sort((a, b) => {
            const aParts = a.split('.').map(Number);
            const bParts = b.split('.').map(Number);

            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
                const aVal = aParts[i] || 0;
                const bVal = bParts[i] || 0;
                if (aVal !== bVal) {
                    return bVal - aVal; // Descending order
                }
            }
            return 0;
        });

        core.info(`All available Windows SDK versions: ${uniqueVersions.join(', ')}`);
        return uniqueVersions[0]; // Return the latest version

    } catch (error) {
        core.debug(`Error detecting Windows SDK version: ${error}`);
        core.warning('Could not automatically detect Windows SDK version. Build may fail if Unity references an unavailable SDK version.');
        return null;
    }
}

/**
 * Removes the WindowsMobile SDKReference from the vcxproj file if it exists
 * This is necessary for Windows SDK versions >= 10.0.26100.0 since it is no longer supported
 */
async function removeWindowsMobileSDKReference(vcxprojPath: string): Promise<void> {
    try {
        const vcxprojContent = await fs.promises.readFile(vcxprojPath, 'utf8');
        const updatedContent = vcxprojContent.replace(
            /<SDKReference Include="WindowsMobile"[^>]*>[\s\S]*?<\/SDKReference>/g,
            ''
        );
        await fs.promises.writeFile(vcxprojPath, updatedContent, 'utf8');
        core.info(`Removed WindowsMobile SDKReference from ${vcxprojPath}`);
    } catch (error) {
        core.warning(`Failed to remove WindowsMobile SDKReference from ${vcxprojPath}: ${error}`);
    }
}