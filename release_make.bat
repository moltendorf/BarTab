@echo off

zip > nul 2>&1 || (
	echo Get zip.exe ^(http://stahlworks.com/dev/index.php?tool=zipunzip^) and add to PATH / copy to same directory
	pause
	goto :EOF
)

if exist build rmdir /S /Q build
if exist release.xpi del release.xpi
mkdir build

copy chrome.manifest.rel build\chrome.manifest

copy install.rdf build
copy icon.png build
xcopy /E /I defaults build\defaults
xcopy /E /I modules build\modules

zip -r build\bartab.jar content locale

path %~dp0;%PATH%

pushd build
zip -r ..\release.xpi *
popd
