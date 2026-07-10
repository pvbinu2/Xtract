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

  @Post('preferences')
  updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() body: { preferredCurrency?: 'USD' | 'INR' | 'GBP' | 'EUR' },
  ) {
    return this.authService.updatePreferences(request.user!.id, body);
  }
}
