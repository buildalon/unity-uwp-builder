import fs = require('fs');
import path = require('path');
import {
  associateAppWithStore,
  removeWindowsMobileSDKReference
} from '../utils';
import {
  expectDiffToMatch,
  getFileDiff
} from './testUtils';

describe('UWP Project XML Editing', () => {
  const sourceDir = path.join(__dirname, 'source');
  const resultsDir = path.join(__dirname, 'results');

  beforeAll(() => {
    if (fs.existsSync(resultsDir)) {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(resultsDir, { recursive: true });
    const srcVcxproj = path.join(sourceDir, 'DummyApp.vcxproj');
    fs.copyFileSync(srcVcxproj, path.join(resultsDir, 'DummyApp.vcxproj'));
    const srcManifest = path.join(sourceDir, 'Package.appxmanifest');
    fs.copyFileSync(srcManifest, path.join(resultsDir, 'Package.appxmanifest'));
    const srcAssoc = path.join(sourceDir, 'Package.StoreAssociation.xml');
    fs.copyFileSync(srcAssoc, path.join(resultsDir, 'Package.StoreAssociation.xml'));
  });

  it('removes WindowsMobile SDKReference from DummyApp.vcxproj (git diff)', async () => {
    const vcxprojTestFilePath = path.join(resultsDir, 'DummyApp.vcxproj');
    const result = await removeWindowsMobileSDKReference(vcxprojTestFilePath);
    expect(result).toBe(true);
    // Check if the SDKReference was removed using regex
    const fileContents = fs.readFileSync(vcxprojTestFilePath, 'utf8');
    const regex = /<SDKReference Include="WindowsMobile" Version="[\d.]+" \/>/;
    expect(regex.test(fileContents)).toBe(false);

    // check that the file diff matches the expected diff `src\__tests__\source\remove-mobile-sdk.diff`
    const sourceVcxproj = path.join(sourceDir, 'DummyApp.vcxproj');
    const expectedDiffPath = path.join(sourceDir, 'remove-mobile-sdk.diff');
    const actualDiff = getFileDiff(sourceVcxproj, vcxprojTestFilePath);
    let expectedDiff = fs.readFileSync(expectedDiffPath, 'utf8');
    expectDiffToMatch(actualDiff, expectedDiff);
  });

  it('associateAppWithStore updates Package.appxmanifest with store association info', async () => {
    const vcxprojTestFilePath = path.join(resultsDir, 'DummyApp.vcxproj');
    const storeAssociationTestPath = path.join(resultsDir, 'Package.StoreAssociation.xml');
    const manifestTestPath = path.join(resultsDir, 'Package.appxmanifest');
    await associateAppWithStore(vcxprojTestFilePath, storeAssociationTestPath);
    const updatedManifest = fs.readFileSync(manifestTestPath, 'utf8');
    expect(updatedManifest).toContain('Identity');
    expect(updatedManifest).toContain('Publisher');
    expect(updatedManifest).toContain('DisplayName');
    const vcxprojContent = fs.readFileSync(vcxprojTestFilePath, 'utf8');
    expect(vcxprojContent).toContain('Package.StoreAssociation.xml');
    expect(vcxprojContent).toContain('GenerateTemporaryStoreCertificate');
    expect(vcxprojContent).toContain('true');

    // Check that the file diff matches the expected diff `src\__tests__\source\associate-store.diff`
    const sourceVcxproj = path.join(sourceDir, 'DummyApp.vcxproj');
    const expectedDiffPath = path.join(sourceDir, 'associate-store.diff');
    const actualDiff = getFileDiff(sourceVcxproj, vcxprojTestFilePath);
    let expectedDiff = fs.readFileSync(expectedDiffPath, 'utf8');
    expectDiffToMatch(actualDiff, expectedDiff);
  });
});