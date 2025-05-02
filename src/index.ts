import core = require('@actions/core');
import exec = require('@actions/exec');
import glob = require('@actions/glob');
import path = require('path');
import fs = require('fs');

const main = async () => {
    try {
        if (process.platform !== `win32`) { throw new Error(`This action can only run on Windows runner.`); }
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
        switch (packageType) {
            case `upload`:
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=StoreUpload`,
                    `/p:GenerateAppInstallerFile=false`,
                    `/p:AppxPackageSigningEnabled=false`,
                    `/p:BuildAppxUploadPackageForUap=true`
                );
                break;
            case `sideload`:
                const certificatePath = await getCertificatePath(projectPath);
                // https://learn.microsoft.com/en-us/windows/uwp/packaging/auto-build-package-uwp-apps
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=SideloadOnly`,
                    `/p:AppxPackageSigningEnabled=true`,
                    `/p:PackageCertificateThumbprint=""`, // The PackageCertificateThumbprint argument is intentionally set to an empty string as a precaution. If the thumbprint is set in the project but does not match the signing certificate, the build will fail with the error: Certificate does not match supplied signing thumbprint.
                    `/p:PackageCertificateKeyFile="${certificatePath}"`,
                );
                const certificatePassword = core.getInput(`certificate-password`);
                if (certificatePassword && certificatePassword.length > 0 && certificatePassword !== '') {
                    buildArgs.push(`/p:PackageCertificatePassword="${certificatePassword}"`);
                }
                break;
            default:
                throw new Error(`Invalid package type: "${packageType}"`);
        }
        const additionalArgs = core.getInput(`additional-args`);
        if (additionalArgs) {
            core.debug(`additional-args: "${additionalArgs}"`);
            buildArgs.push(...additionalArgs.split(` `));
        }
        if (!core.isDebug()) {
            buildArgs.push(`/verbosity:minimal`);
        }
        await exec.exec(`msbuild`, [`"${buildPath}"`, ...buildArgs], {
            windowsVerbatimArguments: true
        });
        const outputDirectory = path.join(projectPath, `AppPackages`);
        core.debug(`outputDirectory: ${outputDirectory}`);
        core.setOutput(`output-directory`, outputDirectory);
        const patterns = [
            `${outputDirectory}/**/*.appx`,
            `${outputDirectory}/**/*.msix`,
            `${outputDirectory}/**/*.appxbundle`,
            `${outputDirectory}/**/*.msixbundle`,
            `${outputDirectory}/**/*.appxupload`,
            `${outputDirectory}/**/*.msixupload`,
            `!${outputDirectory}/**/dependencies/**`
        ];
        const executableGlobber = await glob.create(patterns.join(`\n`));
        const executables = await executableGlobber.glob();
        if (executables.length === 0) {
            throw new Error(`No executable file found in "${outputDirectory}".`);
        }
        core.debug(`Found executables:`);
        executables.forEach(executable => core.debug(`  - "${executable}"`));
        let executable: string | undefined;
        switch (packageType) {
            case `upload`:
                executable = executables.find(file => file.endsWith(`.appxupload`) || file.endsWith(`.msixupload`));
                break;
            case `sideload`:
                executable = executables.find(file => file.endsWith(`.appx`) || file.endsWith(`.msix`));
                break;
        }
        if (!executable) {
            throw new Error(`No matching executable found for package type "${packageType}".`);
        }
        core.debug(`Found executable: "${executable}"`);
        core.setOutput(`executable`, executable);
    } catch (error) {
        core.setFailed(error);
    }
}

main();

async function getCertificatePath(projectPath: string): Promise<string> {
    let certificatePath = core.getInput(`certificate-path`) || `${projectPath}/**/*.pfx`;
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
            throw new Error(`No certificate file found: "${certificatePath}"`);
        }
        certificatePath = certificateFiles[0];
    }
    try {
        await fs.promises.access(certificatePath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Certificate file not found: "${certificatePath}"`);
    }
    return certificatePath;
}
