import core = require('@actions/core');
import exec = require('@actions/exec');
import glob = require('@actions/glob');
import path = require('path');
import fs = require('fs');

const main = async () => {
    try {
        if (process.platform !== `win32`) { throw new Error(`This action can only be performed on a Windows runner.`); }
        let projectPath = core.getInput(`project-path`, { required: true });
        core.debug(`project-path: "${projectPath}"`);
        if (!projectPath.endsWith(`.sln`)) {
            projectPath = path.join(projectPath, `**/*.sln`);
        }
        let buildPath = projectPath;
        if (projectPath.includes('*')) {
            const globber = await glob.create(projectPath, { matchDirectories: false });
            const files = await globber.glob();
            core.debug(`Found solution files:`);
            files.forEach(file => core.debug(`  - "${file}"`));
            if (files.length === 0) { throw new Error(`No solution file found.`); }
            buildPath = files[0];
        }
        core.info(`Building ${buildPath}...`);
        projectPath = path.dirname(buildPath);
        try {
            await fs.promises.access(buildPath, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Solution file not found: "${buildPath}"`);
        }
        const appPackagesPath = path.join(projectPath, `AppPackages`);
        if (fs.existsSync(appPackagesPath)) {
            core.info(`Cleaning AppPackages directory: ${appPackagesPath}...`);
            await fs.promises.rm(appPackagesPath, { recursive: true, force: true });
        }
        let projectName = path.basename(buildPath, `.sln`);
        core.debug(`projectName: "${projectName}"`);
        const configuration = core.getInput(`configuration`, { required: true });
        const buildArgs = [
            `/t:Build`,
            `/p:Configuration=${configuration}`
        ];
        const architecture = core.getInput(`architecture`);
        if (architecture) {
            core.debug(`architecture: "${architecture}"`);
            buildArgs.push(`/p:Platform=${architecture}`);
        }
        const packageType = core.getInput(`package-type`, { required: true });
        core.debug(`package-type: "${packageType}"`);
        const packageFormat = (core.getInput(`package-format`) || 'appx').toLocaleLowerCase();
        core.debug(`package-format: "${packageFormat}"`);
        if (packageFormat !== 'appx' && packageFormat !== 'msix') {
            throw new Error(`Invalid package format: "${packageFormat}". Must be either "appx" or "msix".`);
        }
        const useAppxFormat = packageFormat === 'appx';
        core.info(`Requested package format: ${packageFormat}`);
        core.info(`Requested package type: ${packageType}`);
        const publisherDisplayName = core.getInput('publisher-display-name');
        if (publisherDisplayName) {
            core.debug(`publisher-display-name: "${publisherDisplayName}"`);
            buildArgs.push(`/p:PublisherDisplayName=\"${publisherDisplayName}\"`);
        }
        switch (packageType) {
            case `upload`:
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=StoreUpload`,
                    `/p:GenerateAppInstallerFile=false`,
                    `/p:AppxPackageSigningEnabled=false`,
                    `/p:BuildAppxUploadPackageForUap=true`,
                    `/p:AppxBundle=Always`,
                    `/p:AppxBundlePlatforms="${architecture || 'x64'}"`
                );
                break;
            case `sideload`:
                const certificatePath = await getCertificatePath(projectPath);
                // https://learn.microsoft.com/en-us/windows/uwp/packaging/auto-build-package-uwp-apps
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=SideloadOnly`,
                    `/p:AppxPackageSigningEnabled=true`,
                    `/p:PackageCertificateThumbprint=""`,
                    `/p:PackageCertificateKeyFile="${certificatePath}"`,
                    `/p:AppxBundle=Always`,
                    `/p:AppxBundlePlatforms="${architecture || 'x64'}"`,
                    `/p:GenerateTestCertificate=false`
                );
                const certificatePassword = core.getInput(`certificate-password`);
                if (certificatePassword) {
                    buildArgs.push(`/p:PackageCertificatePassword="${certificatePassword}"`);
                }
                break;
            default:
                throw new Error(`Invalid package type: "${packageType}"`);
        }
        if (useAppxFormat) {
            core.info('use appx/appxbundle output');
            buildArgs.push(`/p:UseAppxFormat=true`);
        }
        const additionalArgs = core.getInput(`additional-args`);
        if (additionalArgs) {
            core.debug(`additional-args: "${additionalArgs}"`);
            buildArgs.push(...additionalArgs.split(` `));
        }
        if (!core.isDebug()) {
            buildArgs.push(`/verbosity:minimal`);
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
        core.info(`Final MSBuild arguments:`);
        buildArgs.forEach(arg => core.info(`  ${arg}`));
        core.startGroup(`MSBuild`);
        try {
            await exec.exec(`msbuild`, [`"${buildPath}"`, ...buildArgs], {
                windowsVerbatimArguments: true
            });
        } finally {
            core.endGroup();
        }
        const outputDirectory = path.join(projectPath, `AppPackages`);
        core.info(`outputDirectory: ${outputDirectory}`);
        core.setOutput(`output-directory`, outputDirectory);

        // Find the directory containing Install.ps1
        const installScriptGlobber = await glob.create(`${outputDirectory}/**/Install.ps1`);
        const installScripts = await installScriptGlobber.glob();
        if (installScripts.length === 0) {
            throw new Error(`No Install.ps1 found in "${outputDirectory}". Cannot determine main package directory.`);
        }
        // Use the first Install.ps1 found
        const mainPackageDir = path.dirname(installScripts[0]);
        core.info(`Main package directory: ${mainPackageDir}`);

        // Only look for executables in the main package directory (not subdirectories)
        const exts = [".appxbundle", ".msixbundle", ".appxupload", ".msixupload", ".appx", ".msix"];
        const dirEntries = await fs.promises.readdir(mainPackageDir);
        const executables = dirEntries
            .filter(file => exts.some(ext => file.toLowerCase().endsWith(ext)))
            .map(file => path.join(mainPackageDir, file));

        if (executables.length === 0) {
            throw new Error(`No executable file found in main package directory: "${mainPackageDir}".`);
        }
        core.info(`Found executables in main package directory:`);
        executables.forEach(executable => core.info(`  - "${executable}"`));

        let executable: string | undefined;
        switch (packageType) {
            case `upload`:
                if (useAppxFormat) {
                    executable = executables.find(file => file.endsWith(`.appxupload`));
                }
                // fallback to msixupload
                if (!executable) {
                    executable = executables.find(file => file.endsWith(`.msixupload`));
                }
                break;
            case `sideload`:
                if (useAppxFormat) {
                    // Only accept .appxbundle or .appx for sideload/appx
                    executable = executables.find(file => file.endsWith(`.appxbundle`)) ||
                        executables.find(file => file.endsWith(`.appx`));
                }
                // fallback to msix/msixbundle
                if (!executable) {
                    executable = executables.find(file => file.endsWith(`.msixbundle`)) ||
                        executables.find(file => file.endsWith(`.msix`));
                }
                break;
        }
        if (!executable) {
            throw new Error(`No matching executable found for package type "${packageType}" in main package directory.`);
        }
        core.info(`Found executable: "${executable}"`);
        core.setOutput(`executable`, executable);
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
