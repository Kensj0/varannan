@echo off
setlocal enabledelayedexpansion

cd /d C:\Firebase\Varannan

echo.
echo ====== VARANNAN DEPLOY ======
echo.
echo Vad vill du deploya?
echo 1 - Frontend (hosting)
echo 2 - Cloud Functions
echo 3 - Båda (parallellt)
echo 4 - Full deploy
echo.

set /p choice="Välj (1-4): "

if "%choice%"=="1" (
    echo Deployer hosting...
    call npm run build
    call firebase deploy --only hosting
) else if "%choice%"=="2" (
    echo Deployer functions...
    call firebase deploy --only functions
) else if "%choice%"=="3" (
    echo Deployer hosting och functions parallellt...
    call npm run build
    call firebase deploy --only hosting,functions
) else if "%choice%"=="4" (
    echo Deployer allt...
    call npm run build
    call firebase deploy
) else (
    echo Ogiltigt val.
    exit /b 1
)

echo.
echo Deploy klart!
echo.
