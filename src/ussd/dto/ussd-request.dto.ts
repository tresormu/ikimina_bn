import { IsString, IsNotEmpty } from 'class-validator';

export class UssdRequestDto {
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  networkCode: string;

  @IsString()
  serviceCode: string;

  @IsString()
  text: string;
}
