import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './auth.decorators';
import { AuthenticatedRequest } from './auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.authService.login(body.username, body.password);
  }

  @Public()
  @Post('two-factor/verify-login')
  verifyTwoFactorLogin(@Body() body: { twoFactorToken: string; code: string }) {
    return this.authService.verifyTwoFactorLogin(body.twoFactorToken, body.code);
  }

  @Public()
  @Post('two-factor/required-setup')
  beginRequiredTwoFactorSetup(@Body() body: { twoFactorSetupToken: string }) {
    return this.authService.beginRequiredTwoFactorSetup(body.twoFactorSetupToken);
  }

  @Public()
  @Post('two-factor/required-setup/complete')
  completeRequiredTwoFactorSetup(
    @Body() body: { twoFactorSetupToken: string; secret: string; code: string },
  ) {
    return this.authService.completeRequiredTwoFactorSetup(
      body.twoFactorSetupToken,
      body.secret,
      body.code,
    );
  }

  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }

  @Post('change-password')
  changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(request.user!.id, body.currentPassword, body.newPassword);
  }

  @Post('two-factor/setup')
  beginTwoFactorSetup(@Req() request: AuthenticatedRequest) {
    return this.authService.beginTwoFactorSetup(request.user!.id);
  }

  @Post('two-factor/enable')
  enableTwoFactor(
    @Req() request: AuthenticatedRequest,
    @Body() body: { secret: string; code: string },
  ) {
    return this.authService.enableTwoFactor(request.user!.id, body.secret, body.code);
  }

  @Post('preferences')
  updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() body: { preferredCurrency?: 'USD' | 'INR' | 'GBP' | 'EUR' },
  ) {
    return this.authService.updatePreferences(request.user!.id, body);
  }
}
